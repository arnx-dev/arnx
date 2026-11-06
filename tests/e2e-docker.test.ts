// Docker end to end: real sandbox and Postgres, scripted models. Run with ARNX_DOCKER_TESTS=1.
import { describe, expect, test } from "bun:test";
import { blankMarks } from "./helpers/review";
import { appendFileSync, cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { basename, dirname, join } from "node:path";
import { accept } from "../src/accept";
import { snapshot, takeSnapshot } from "../src/change";
import { check, checkJson, checkSummary } from "../src/check";
import { isApproved, loadReviewFile, parseReviewConfig, parseReviewFile, reviewConfigPath, stamp } from "../src/config";
import type { AgentModel, Block, JsonModel } from "../src/llm";
import { recheckJson, recheckReview, recheckSummary } from "../src/recheck";
import { docker, dockerSteps, ensureEnv, networkNotice, Session } from "../src/sandbox";
import { runTests, type TestResult } from "../src/outcomes";
import { python } from "../src/adapters/python";
import { clearReach, readReach } from "../src/reached";
import { dockerSession } from "../src/testround";
import { fake } from "../src/secrets";
import { EVENTS_FILE } from "../src/events";
import { exitCode } from "../src/report";
import { runReview } from "../src/reviewer";
import { defaultSettings } from "../src/settings";
import { approveConfig, approveFile, rerecordBaseline, runSetup } from "../src/setup";
import { FakeJson, ScriptedAgent, text, tool } from "./helpers/fakes";
import { commit, initRepo } from "./helpers/gitutil";
import { useTmp } from "./helpers/tmp";

const FIXTURE = join(import.meta.dir, "fixtures", "invites");
const YAML = `version: 1
image: python:3.12-slim
install: [pip install -r requirements.txt]
test_command: python -m pytest -q {targets}
services:
  db:
    image: postgres:16-alpine
    env: {POSTGRES_HOST_AUTH_METHOD: trust}
    ready: pg_isready -U postgres -h 127.0.0.1
env:
  DATABASE_URL: postgresql://postgres@db:5432/postgres
notes: [invites.connect() reads DATABASE_URL; drop and re-create tables in each test]
`;
const INVITE = `

def invite(conn, team_id, actor, email):
    """Team admins invite people by email."""
    if role_of(conn, team_id, actor) is None:
        raise PermissionError("not a member")
    conn.execute("INSERT INTO invites VALUES (%s, %s)", (team_id, email))
`;
const GEN = "tests/arnx_generated/test_invite.py";
const TEST = `import pytest
import invites


@pytest.fixture
def conn():
    c = invites.connect()
    c.execute("DROP TABLE IF EXISTS members, invites")
    invites.init_db(c)
    yield c
    c.close()


def test_member_cannot_invite(conn):
    invites.add_member(conn, 1, "m@x", "member")
    with pytest.raises(PermissionError):
        invites.invite(conn, 1, "m@x", "new@x")


def test_admin_can_invite(conn):
    invites.add_member(conn, 1, "a@x", "admin")
    invites.invite(conn, 1, "a@x", "new@x")
`;
const tmp = useTmp();

describe.skipIf(!process.env.ARNX_DOCKER_TESTS)("docker", () => {
  test("test_review_and_accept_in_docker", async () => {
    const repo = initRepo(join(tmp(), "invites"));
    cpSync(FIXTURE, repo, { recursive: true });
    commit(repo, "members");
    mkdirSync(dirname(reviewConfigPath(repo)));
    writeFileSync(reviewConfigPath(repo), YAML);
    const [ok, detail] = await approveConfig(repo, { by: "Dev", at: "2026-10-11" });
    expect(detail).toBeTruthy();
    expect(ok).toBe(true);
    appendFileSync(join(repo, "invites.py"), INVITE);
    commit(repo, "invites");

    const report = text(`{"tests": [], "suspected_defects": [{"test": "${GEN}::test_member_cannot_invite", ` +
      '"explanation": "Any member can invite; only admins should."}], "questions": []}');
    // The test connects through invites.connect() and never names DATABASE_URL, so the database follow-up is asked
    // once; the reviewer answers with the same report.
    const agent = new ScriptedAgent([
      [tool("write_file", { path: GEN, content: TEST })],
      [tool("run_tests")],
      [report],
      [report],
    ]);
    const settings = { ...defaultSettings(), consentAt: "2026-10-11T00:00:00Z" };
    const { review, rdir } = await runReview(repo, { settings, agentModel: agent,
      challenger: new FakeJson([{ verdict: "confirmed", reason: "role never checked" }]) });
    expect(review.missingRuns).toBe(0);
    expect(review.findings.map((f) => f.func)).toEqual(["test_member_cannot_invite"]);
    expect(review.passed).toBe(1);
    const toolOutput = (agent.calls[2]!.messages.at(-1)!.content as Record<string, unknown>[])[0]!.content;
    expect(String(toolOutput)).toContain("1 failed, 1 passed");
    expect(String(agent.calls[3]!.messages.at(-1)!.content)).toContain("hold database code");
    expect(exitCode(review)).toBe(0);
    // invite() is what the change adds: on the code before it the test cannot find it
    expect(review.findings[0]!.before!.status).toBe("new-code");
    console.log(`before/after check with Postgres: ${review.timings!.beforeCheckSecs} s of a ${review.seconds} s review`);

    const md = blankMarks(readFileSync(join(rdir, "review.md"), "utf8")).replace("Mark: [ ] real", "Mark: [x] real");
    writeFileSync(join(rdir, "review.md"), md);
    const result = await accept(repo, rdir, settings);
    // named after what it protects: the finding's explanation
    expect(result.kept.map((p) => basename(p))).toContain("test_any_member_can_invite_only_admins_should.py");
    expect(isApproved(parseReviewConfig(readFileSync(reviewConfigPath(repo), "utf8")))).toBe(true);
    // The project's own pytest run, with .arnx/tests/ there as in the repository, never collects the kept test; arnx
    // check puts it in place in its copy and runs it: red until the bug is fixed.
    const cfg = loadReviewFile(repo).projects[0]!;
    const snap = join(tmp(), "own");
    snapshot(repo, null, snap, [], { untracked: true });
    cpSync(join(repo, ".arnx", "tests"), join(snap, ".arnx", "tests"), { recursive: true });
    const own = await dockerSession(cfg, snap, join(tmp(), "build.log"),
      async (s) => (await runTests(s, snap, cfg, [], "own.xml", 600))[1]);
    expect(own?.length).toBeGreaterThan(0);
    expect(own!.filter((t) => t.testId.includes(".arnx"))).toEqual([]);
    const [r] = await check(repo, settings);
    expect(r!.failed.map((t) => t.testId.split("::").at(-1))).toContain("test_member_cannot_invite");
  }, 900_000);

  test("before/after check: a regression, a pre-existing failure and new code, told apart in Docker", async () => {
    const repo = initRepo(join(tmp(), "calc"));
    writeFileSync(join(repo, "calc.py"), "def add(a, b):\n    return a + b\n\n\ndef mul(a, b):\n    return a + b\n");
    writeFileSync(join(repo, "requirements.txt"), "pytest>=8,<9\n");
    mkdirSync(join(repo, "tests"));
    writeFileSync(join(repo, "tests/test_calc.py"), "from calc import add\n\n\ndef test_add():\n    assert add(1, 1) == 2\n");
    mkdirSync(dirname(reviewConfigPath(repo)));
    writeFileSync(reviewConfigPath(repo), "version: 1\nimage: python:3.12-slim\ninstall: [pip install -r " +
      "requirements.txt]\ntest_command: python -m pytest -q {targets}\n");
    commit(repo, "calc");
    const [ok] = await approveConfig(repo, { by: "Dev", at: "2026-10-17" });
    expect(ok).toBe(true);
    // add() breaks, mul() was already wrong, neg() is new (and wrong)
    writeFileSync(join(repo, "calc.py"), "def add(a, b):\n    return a - b\n\n\ndef mul(a, b):\n    return a + b\n" +
      "\n\ndef neg(x):\n    return x\n");
    commit(repo, "subtract, neg");
    const gen = "tests/arnx_generated/test_calc.py";
    // As a real reviewer replies: its report names every test it wrote, the failing ones included.
    const report = text(JSON.stringify({ tests: [
      { test: `${gen}::test_add`, expects: "add sums" }, { test: `${gen}::test_mul`, expects: "mul multiplies" },
      { test: `${gen}::test_neg`, expects: "neg negates" }], suspected_defects: [], questions: [] }));
    const agent = new ScriptedAgent([
      [tool("write_file", { path: gen, content: "from calc import add, mul\n\n\ndef test_add():\n    assert add(2, 3) " +
        "== 5\n\n\ndef test_mul():\n    assert mul(2, 3) == 6\n\n\ndef test_neg():\n    from calc import neg\n" +
        "    assert neg(2) == -2\n" })],
      [report],
      [report], // a coverage follow-up, if asked
    ]);
    const said: string[] = [];
    const settings = { ...defaultSettings(), consentAt: "2026-10-17T00:00:00Z" };
    const { review, rdir } = await runReview(repo, { settings, agentModel: agent, progress: (m) => said.push(m),
      challenger: new FakeJson([{ verdict: "confirmed", reason: "a" }, { verdict: "confirmed", reason: "b" }]) });
    expect(review.missingRuns).toBe(0);
    expect(review.findings.map((f) => [f.func, f.before!.status])).toEqual([["test_add", "regression"],
      ["test_mul", "pre-existing"], ["test_neg", "new-code"]]);
    expect(review.findings.map((f) => f.verdict)).toEqual(["confirmed", null, "confirmed"]);
    expect(exitCode(review)).toBe(0);
    expect(said.some((m) => m.endsWith("running 3 failing tests on the code before the change"))).toBe(true);
    expect(said.some((m) => /before the change: 1 failing test passes there, fails with the change; 1 fails with the same message /
      .test(m) && /there; 1 cannot run there \(what it tests is new\) \([\d.]+ s\)$/.test(m)))
      .toBe(true);
    const done = readFileSync(join(rdir, EVENTS_FILE), "utf8").split("\n").filter(Boolean)
      .map((l) => JSON.parse(l) as { type: string; data: Record<string, number> }).find((e) => e.type === "before.done")!;
    // the cost of the check, for the record (the owner asked how much time it adds)
    console.log(`before/after check: ${review.timings!.beforeCheckSecs} s of a ${review.seconds} s review ` +
      `(snapshot ${done.data.snapshot_ms} ms, runs ${done.data.runs_ms} ms, total ${done.data.duration_ms} ms)`);
  }, 900_000);

  test("fix proof: a passing test that fails on the code before the change proves the fix, in Docker", async () => {
    const repo = initRepo(join(tmp(), "fix"));
    writeFileSync(join(repo, "calc.py"), "def add(a, b):\n    return a - b\n\n\ndef mul(a, b):\n    return a * b\n");
    writeFileSync(join(repo, "requirements.txt"), "pytest>=8,<9\n");
    mkdirSync(join(repo, "tests"));
    writeFileSync(join(repo, "tests/test_calc.py"), "from calc import mul\n\n\ndef test_mul():\n    assert mul(1, 1) == 1\n");
    mkdirSync(dirname(reviewConfigPath(repo)));
    writeFileSync(reviewConfigPath(repo), "version: 1\nimage: python:3.12-slim\ninstall: [pip install -r " +
      "requirements.txt]\ntest_command: python -m pytest -q {targets}\n");
    commit(repo, "calc");
    const [ok] = await approveConfig(repo, { by: "Dev", at: "2026-10-20" });
    expect(ok).toBe(true);
    // the change fixes add() and adds neg(); mul() was right all along
    writeFileSync(join(repo, "calc.py"), "def add(a, b):\n    return a + b\n\n\ndef mul(a, b):\n    return a * b\n" +
      "\n\ndef neg(x):\n    return -x\n");
    commit(repo, "fix add, neg");
    const gen = "tests/arnx_generated";
    const report = text(JSON.stringify({ tests: [{ test: `${gen}/test_calc.py::test_add`, expects: "add sums" }],
      suspected_defects: [], questions: [] }));
    const agent = new ScriptedAgent([
      [tool("write_file", { path: `${gen}/test_calc.py`, content: "from calc import add, mul\n\n\ndef test_add():\n" +
        "    assert add(2, 3) == 5\n\n\ndef test_mul():\n    assert mul(2, 3) == 6\n" }),
      tool("write_file", { path: `${gen}/test_neg.py`, content: "from calc import neg\n\n\ndef test_neg():\n" +
        "    assert neg(2) == -2\n" })],
      [report],
      [report], // a coverage follow-up, if asked
    ]);
    const settings = { ...defaultSettings(), consentAt: "2026-10-20T00:00:00Z" };
    const { review, rdir } = await runReview(repo, { settings, agentModel: agent, challenger: new FakeJson([]) });
    expect(review.missingRuns).toBe(0);
    expect(review.findings).toEqual([]);
    expect(review.fixProof!.map((x) => [x.testId.split("::")[1], x.beforeStatus])).toEqual([["test_add", "fixed"],
      ["test_mul", "unchanged"], ["test_neg", "new-code"]]);
    expect(exitCode(review)).toBe(0);
    const md = readFileSync(join(rdir, "review.md"), "utf8");
    expect(md).toContain("## Fails before the change, passes with it");
    expect(md).toContain("- `tests/arnx_generated/test_calc.py::test_add`: add sums");
    console.log(`fix proof: ${review.timings!.fixProofSecs} s of a ${review.seconds} s review`);
  }, 900_000);

  test("a repository with no commits yet: approve, review every file, accept", async () => {
    const repo = initRepo(join(tmp(), "fresh"));
    writeFileSync(join(repo, "calc.py"), "def add(a, b):\n    return a - b\n");
    writeFileSync(join(repo, "requirements.txt"), "pytest>=8,<9\n");
    mkdirSync(join(repo, "tests"));
    writeFileSync(join(repo, "tests/test_calc.py"), "from calc import add\n\n\ndef test_zero():\n    assert add(0, 0) == 0\n");
    mkdirSync(dirname(reviewConfigPath(repo)));
    writeFileSync(reviewConfigPath(repo), "version: 1\nimage: python:3.12-slim\ninstall: [pip install -r " +
      "requirements.txt]\ntest_command: python -m pytest -q {targets}\n");
    const [ok] = await approveConfig(repo, { by: "Dev", at: "2026-10-20" });
    expect(ok).toBe(true);
    const gen = "tests/arnx_generated/test_calc.py";
    // The report names the failing test it wrote, as a real reviewer's does; it gives no expects, so no explanation.
    const report = text(JSON.stringify({ tests: [{ test: `${gen}::test_add` }], suspected_defects: [], questions: [] }));
    const agent = new ScriptedAgent([
      [tool("write_file", { path: gen, content: "from calc import add\n\n\ndef test_add():\n    assert add(2, 3) == 5\n" })],
      [report],
      [report], // a coverage follow-up, if asked
    ]);
    const settings = { ...defaultSettings(), consentAt: "2026-10-20T00:00:00Z" };
    const { review, rdir } = await runReview(repo, { settings, agentModel: agent,
      challenger: new FakeJson([{ verdict: "confirmed", reason: "add subtracts" }]) });
    expect(review.change).toBe("all files (no commits yet)");
    expect(review.missingRuns).toBe(0);
    expect(review.findings.map((f) => [f.func, f.before!.status])).toEqual([["test_add", "unknown"]]);
    expect(review.beforeBaseEmpty).toBe("first-commit");
    expect(exitCode(review)).toBe(0);
    const md = blankMarks(readFileSync(join(rdir, "review.md"), "utf8")).replace("Mark: [ ] real", "Mark: [x] real");
    writeFileSync(join(rdir, "review.md"), md);
    const result = await accept(repo, rdir, settings);
    // no explanation: named after its test function
    expect(result.kept.map((p) => basename(p))).toEqual(["test_add.py"]);
  }, 900_000);

  test("approve refuses a test_command that runs a fixed folder besides {targets}, and stamps the fixed one",
    async () => {
    const repo = initRepo(join(tmp(), "integ"));
    writeFileSync(join(repo, "calc.py"), "def add(a, b):\n    return a + b\n");
    writeFileSync(join(repo, "requirements.txt"), "pytest>=8,<9\n");
    for (const dir of ["tests", "integ_tests"]) mkdirSync(join(repo, dir));
    writeFileSync(join(repo, "tests/test_calc.py"), "from calc import add\n\n\ndef test_add():\n    assert add(1, 1) == 2\n");
    writeFileSync(join(repo, "integ_tests/test_ui.py"), "def test_page():\n    pass\n\n\ndef test_login():\n    pass\n");
    writeFileSync(join(repo, "integ_tests/test_api.py"), "def test_api():\n    pass\n");
    mkdirSync(dirname(reviewConfigPath(repo)));
    const yaml = (command: string) => "version: 1\nimage: python:3.12-slim\ninstall: [pip install -r " +
      `requirements.txt]\ntest_command: ${command}\n`;
    writeFileSync(reviewConfigPath(repo), yaml("python -m pytest -r s {targets} integ_tests"));
    commit(repo, "calc");
    // With no targets the command runs integ_tests alone; with the probe as its target, integ_tests as well.
    const [ok, detail] = await approveConfig(repo, { by: "Dev", at: "2026-10-20" });
    expect(ok).toBe(false);
    expect(detail).toContain("3 passed; but test_command does not run only {targets}: run with only arnx's one-line " +
      "test in tests/arnx_generated/ as its target, it also ran 3 tests from 2 other files (integ_tests/test_api.py, " +
      "integ_tests/test_ui.py)");
    expect(isApproved(parseReviewConfig(readFileSync(reviewConfigPath(repo), "utf8")))).toBe(false);
    writeFileSync(reviewConfigPath(repo), yaml("python -m pytest -r s {targets}"));
    const [ok2, detail2] = await approveConfig(repo, { by: "Dev", at: "2026-10-20" });
    expect([ok2, detail2]).toEqual([true, "4 passed"]);
  }, 900_000);

  // --- a service network ------------------------------------------------------------------------------------------------
  test("a test on a service network reaches its services, and no listener on this machine through the network's gateway", async () => {
    const server = createServer((c) => c.end("listening\n"));
    await new Promise<void>((done) => server.listen(0, "0.0.0.0", done));
    const port = (server.address() as AddressInfo).port;
    const cfg = parseReviewFile(`version: 1\nimage: python:3.12-slim\ntest_command: python -m pytest -q {targets}\n` +
      "services:\n  cache:\n    image: redis:7-alpine\n    ready: redis-cli ping\n").projects[0]!;
    const reach = (host: string, p = port) => `python -c "import socket; s = socket.create_connection(('${host}', ${p}), 3); ` +
      `print('reached')" 2>&1 | tail -1`;
    const dockerOut = (...args: string[]) => docker(args).stdout.trim();
    // The check bites: on a network with the old options the same listener answers from the gateway.
    const open = `arnx-open-${process.pid}`;
    docker(["network", "create", "--internal", open]);
    try {
      const gateway = dockerOut("network", "inspect", open, "-f", "{{(index .IPAM.Config 0).Gateway}}");
      const control = docker(["run", "--rm", "--network", open, "python:3.12-slim", "sh", "-c", reach(gateway)]).stdout;
      expect(control).toContain("reached");
    } finally {
      docker(["network", "rm", open]);
    }
    // A protected network is not reported as an open one.
    const noticed: string[] = [];
    const before = { say: dockerSteps.say, said: networkNotice.said };
    dockerSteps.say = (m) => void noticed.push(m);
    networkNotice.said = false;
    const session = await new Session("python:3.12-slim", cfg, tmp()).start().finally(() => {
      dockerSteps.say = before.say;
    });
    try {
      expect(noticed).toEqual([]);
      expect(networkNotice.said).toBe(false);
      networkNotice.said = before.said;
      const made = JSON.parse(dockerOut("network", "inspect", session.network, "-f", "{{json .IPAM.Config}}"));
      expect(made[0].Gateway ?? "").toBe("");
      // What would be its gateway, and the default bridge's, which a test could guess.
      const first = String(made[0].Subnet).replace(/\.0\/\d+$/, ".1");
      const bridge = dockerOut("network", "inspect", "bridge", "-f", "{{(index .IPAM.Config 0).Gateway}}");
      for (const host of [first, bridge]) {
        expect((await session.run(reach(host), 30)).output).not.toContain("reached");
      }
      expect((await session.run(reach("cache", 6379), 30)).output).toContain("reached");
    } finally {
      session.close();
      server.close();
    }
  }, 300_000);

  // --- a real guess in the code ------------------------------------------------------------------------------------
  const GUESS = "zX9qP2vL7mK4tR8b";
  const TOKEN = "cnryQ7vX2mK9pL4zR8tB1nW6yC3f";
  const forms = (v: string) => [v, v.toUpperCase(), v.toLowerCase(), Buffer.from(v).toString("hex"),
    Buffer.from(v).toString("base64"), Buffer.from(v).toString("base64").replace(/=+$/, ""),
    Buffer.from(`app:${v}`).toString("base64")];
  const expectNoForm = (what: string, text: string) => {
    for (const v of [GUESS, TOKEN]) {
      for (const form of forms(v)) if (text.includes(form)) throw new Error(`${what} holds a real value: ${form}`);
    }
  };
  const CANARY_GEN = "tests/arnx_generated/test_canary.py";
  const CANARY_TEST = `import base64
from shop import settings

def test_token():
    assert settings.API_TOKEN == "x"
def test_password():
    assert settings.db_password == "x"
def test_basic():
    assert base64.b64encode(("app:" + settings.db_password).encode()).decode() == "x"
def test_upper():
    assert settings.db_password.upper() == "x"
def test_hex():
    assert settings.db_password.encode().hex() == "x"
`;
  const CANARY_NAMES = ["test_token", "test_password", "test_basic", "test_upper", "test_hex"];
  const recorded = (steps: Block[][], last: string) => {
    const bodies: string[] = [];
    const model: AgentModel = { model: "claude-sonnet-5-5", create: async (a) => {
      bodies.push(JSON.stringify(a));
      const blocks = steps.shift() ?? [text(last)];
      return { content: blocks, usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 }, raw: blocks,
        stopReason: blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn" };
    } };
    return { bodies, model };
  };

  test("a real guess reaches no model and no report, nor its encoded forms, in a real test run", async () => {
    const repo = initRepo(join(tmp(), "canary"));
    mkdirSync(join(repo, "shop"));
    mkdirSync(join(repo, "tests"));
    writeFileSync(join(repo, "shop/__init__.py"), "");
    writeFileSync(join(repo, "shop/settings.py"), `API_TOKEN = "${TOKEN}"\ndb_password = "${GUESS}"\n`);
    writeFileSync(join(repo, "shop/price.py"), "def price(a):\n    return a\n");
    // The project's own test fails quoting the value, in its id and its message.
    writeFileSync(join(repo, "tests/test_own.py"), `import pytest\nfrom shop import settings\n\n` +
      `@pytest.mark.parametrize("v", [settings.db_password])\ndef test_own(v):\n    assert v == "x"\n\ndef test_fine():\n    pass\n`);
    writeFileSync(join(repo, ".gitignore"), "__pycache__\n.arnx/run\n");
    mkdirSync(dirname(reviewConfigPath(repo)));
    const yaml = "version: 1\nimage: python:3.12-slim\ninstall: [pip install pytest]\n" +
      "test_command: python -m pytest -q {targets}\n";
    writeFileSync(reviewConfigPath(repo), stamp(parseReviewConfig(yaml), "Dev", "2026-11-04"));
    // These tests fail before the change too: without that check they stay confirmed, and check --review runs them.
    const settings = { ...defaultSettings(), consentAt: "2026-11-04T00:00:00Z", beforeCheck: false };
    commit(repo, "the code");
    writeFileSync(join(repo, "shop/price.py"), "def price(a):\n    return a + 1\n");
    commit(repo, "a change");
    const report = JSON.stringify({ tests: [], questions: [],
      suspected_defects: CANARY_NAMES.map((n) => ({ test: `${CANARY_GEN}::${n}`, explanation: `${n} is wrong.` })) });
    const agent = recorded([
      [tool("read_file", { path: "shop/settings.py" }), tool("grep", { pattern: "password|TOKEN", path: "." })],
      [tool("write_file", { path: CANARY_GEN, content: CANARY_TEST }), tool("run_tests", {})]], report);
    const judged: string[] = [];
    const judge = { ref: "openai:x", completeJson: async (system: string, user: string) => {
      judged.push(system, user);
      return [{ verdict: "confirmed", reason: "It is wrong.", groups: [] }, 0.01] as const;
    } } as unknown as JsonModel;
    const { review, rdir } = await runReview(repo, { settings, agentModel: agent.model, challenger: judge });
    expect(review.findings.length).toBe(CANARY_NAMES.length);
    // The run was on the real values: the stand-in's own encodings are what the agent read.
    const sent = agent.bodies.join("\n");
    expect(sent).toContain("db_password");
    expectNoForm("the agent's requests", sent);
    expectNoForm("the judge's requests", judged.join("\n"));
    for (const f of [EVENTS_FILE, "review.md", "review.json"]) expectNoForm(f, readFileSync(join(rdir, f), "utf8"));
    for (const f of readdirSync(rdir, { recursive: true }) as string[]) {
      if (f.endsWith("round.json")) expectNoForm(f, readFileSync(join(rdir, f), "utf8"));
    }
    const md = blankMarks(readFileSync(join(rdir, "review.md"), "utf8")).replaceAll("Mark: [ ] real", "Mark: [x] real");
    writeFileSync(join(rdir, "review.md"), md);
    await accept(repo, rdir, settings, { answerRunner: null });
    expectNoForm("fix-prompt.md", readFileSync(join(rdir, "fix-prompt.md"), "utf8"));
    const results = await check(repo, settings);
    expect(results[0]!.failed.length).toBe(CANARY_NAMES.length);
    expectNoForm("arnx check", checkJson(results, 1) + checkSummary(results)[0]);
    const again = await recheckReview(repo, rdir, settings);
    expect(again.findings.length).toBe(CANARY_NAMES.length);
    expectNoForm("arnx check --review", recheckJson(again) + recheckSummary(again)[0]);
    // What setup records from the project's own failing test, which a commit of .arnx/ takes.
    const [baselineSaved] = await rerecordBaseline(repo, { by: "Dev", at: "2026-11-04" });
    expect(baselineSaved).toBe(true);
    const baseline = readFileSync(join(repo, ".arnx/baseline.json"), "utf8");
    expect(baseline).toContain("test_own[");
    expectNoForm("the baseline", baseline);
    const [proven] = await approveFile(repo, { by: "Dev", at: "2026-11-04" });
    expect(proven).toBe(true);
    for (const f of readdirSync(join(repo, ".arnx"), { recursive: true }) as string[]) {
      if (statSync(join(repo, ".arnx", f)).isFile()) expectNoForm(f, readFileSync(join(repo, ".arnx", f), "utf8"));
    }
  }, 600_000);

  // --- a model's stand-in, in a real test run ---------------------------------------------------------------------------
  const SHOWN = fake(GUESS, new Map());
  const SHOWN_B64 = Buffer.from(SHOWN).toString("base64");
  const VALUE_GEN = "tests/arnx_generated/test_value.py";
  const VALUE_TEST = `import base64
from shop import settings

def test_value():
    assert settings.db_password == "${SHOWN}"
def test_encoded_at_run():
    assert base64.b64encode(settings.db_password.encode()) == base64.b64encode(b"${SHOWN}")
def test_on_the_mounted_code():
    assert '"${SHOWN}"' in open("/src/shop/settings.py").read()
def test_encoded_as_written():
    assert base64.b64encode(settings.db_password.encode()).decode() == "${SHOWN_B64}"
`;
  const VALUE_NAMES = ["test_value", "test_encoded_at_run", "test_on_the_mounted_code", "test_encoded_as_written"];
  const valueRepo = (name: string, yaml: string) => {
    const repo = initRepo(join(tmp(), name));
    mkdirSync(join(repo, "shop"));
    mkdirSync(join(repo, "tests"));
    writeFileSync(join(repo, "shop/__init__.py"), "");
    writeFileSync(join(repo, "shop/settings.py"), `db_password = "${GUESS}"\n`);
    writeFileSync(join(repo, "shop/price.py"), "def price(a):\n    return a\n");
    writeFileSync(join(repo, "shop/names.py"), "NAME = 'shop'\n");
    writeFileSync(join(repo, ".gitignore"), "__pycache__\n.arnx/run\n");
    mkdirSync(dirname(reviewConfigPath(repo)));
    writeFileSync(reviewConfigPath(repo), stamp(parseReviewConfig(yaml), "Dev", "2026-11-04"));
    commit(repo, "the code");
    writeFileSync(join(repo, "shop/price.py"), "def price(a):\n    return a + 1\n");
    commit(repo, "a change");
    return repo;
  };
  /** Each test's class in the review's event log. */
  const classes = (rdir: string) => {
    const out: Record<string, string[]> = {};
    for (const line of readFileSync(join(rdir, EVENTS_FILE), "utf8").split("\n").filter(Boolean)) {
      const e = JSON.parse(line);
      if (e.type === "test.classified") (out[e.data.class] ??= []).push(e.data.func);
    }
    return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.sort()]));
  };
  const expectNoReal = (what: string, text: string) => {
    for (const form of forms(GUESS)) if (text.includes(form)) throw new Error(`${what} holds a real value: ${form}`);
  };
  const allIn = (dir: string) => (readdirSync(dir, { recursive: true, withFileTypes: true }) as import("node:fs").Dirent[])
    .filter((e) => e.isFile()).map((e) => [join(e.parentPath, e.name), readFileSync(join(e.parentPath, e.name), "utf8")] as const);

  test("a model's test holding a stand-in passes against the real value in the code, and nothing real is kept", async () => {
    const repo = valueRepo("plain", "version: 1\nimage: python:3.12-slim\ninstall: [pip install pytest]\n" +
      "test_command: python -m pytest -q {targets}\n");
    const settings = { ...defaultSettings(), consentAt: "2026-11-04T00:00:00Z", beforeCheck: false };
    const report = JSON.stringify({ tests: [], questions: [], suspected_defects: [
      { test: `${VALUE_GEN}::test_encoded_as_written`, explanation: "It does not match." }] });
    const agent = recorded([[tool("grep", { pattern: SHOWN, path: "shop" })],
      [tool("write_file", { path: VALUE_GEN, content: VALUE_TEST }), tool("run_tests", {})]], report);
    const judge = { ref: "openai:x", completeJson: async () => [{ verdict: "confirmed", reason: "No.", groups: [] }, 0.01] } as
      unknown as JsonModel;
    const { review, rdir } = await runReview(repo, { settings, agentModel: agent.model, challenger: judge });
    // A stand-in as written comes back; one a model encoded itself does not, and that test fails on the real value.
    expect(classes(rdir)).toEqual({ finding: ["test_encoded_as_written"],
      passed: ["test_encoded_at_run", "test_on_the_mounted_code", "test_value"] });
    expect(review.findings.map((f) => f.testId.split("::")[1])).toEqual(["test_encoded_as_written"]);
    const sent = agent.bodies.join("\n");
    // The grep found the value, and its line came back with the stand-in.
    expect(sent).toContain(`shop/settings.py:1: db_password = \\"${SHOWN}`);
    expectNoReal("the agent's requests", sent);
    const md = blankMarks(readFileSync(join(rdir, "review.md"), "utf8")).replaceAll("Mark: [ ] real", "Mark: [x] real");
    writeFileSync(join(rdir, "review.md"), md);
    await accept(repo, rdir, settings, { answerRunner: null });
    // Accepted, run again: the kept file keeps the stand-in and the run holds the value.
    const results = await check(repo, settings);
    expect(results[0]!.passed.map((t) => t.split("::")[1]).sort()).toEqual(
      ["test_encoded_at_run", "test_on_the_mounted_code", "test_value"]);
    expect(results[0]!.failed.map((t) => t.testId.split("::")[1])).toEqual(["test_encoded_as_written"]);
    const kept = allIn(join(repo, ".arnx"));
    expect(kept.some(([p, t]) => p.includes("/.arnx/tests/") && t.includes(SHOWN))).toBe(true);
    for (const [p, t] of kept) expectNoReal(p, t);
    expect((await recheckReview(repo, rdir, settings)).findings.map((f) => f.status)).toEqual(["still-failing"]);
    for (const [p, t] of allIn(join(repo, ".arnx"))) expectNoReal(p, t);
  }, 600_000);

  test("on a baked copy the same test passes against the copy's stand-in, and one reading the mounted code does not", async () => {
    const repo = valueRepo("baked", "version: 1\nimage: python:3.12-slim\n" +
      "install: [pip install pytest, cp -r . /opt/app]\ntest_command: pytest -q {targets}\nenv: {PYTHONPATH: /opt/app}\n");
    const settings = { ...defaultSettings(), consentAt: "2026-11-04T00:00:00Z", beforeCheck: false };
    const report = JSON.stringify({ tests: [], questions: [], suspected_defects: [] });
    const agent = recorded([[tool("write_file", { path: VALUE_GEN, content: VALUE_TEST }), tool("run_tests", {})]], report);
    const judge = { ref: "openai:x", completeJson: async () => [{ verdict: "confirmed", reason: "No.", groups: [] }, 0.01] } as
      unknown as JsonModel;
    const { rdir } = await runReview(repo, { settings, agentModel: agent.model, challenger: judge });
    expect(classes(rdir)).toEqual({ finding: ["test_on_the_mounted_code"],
      passed: ["test_encoded_as_written", "test_encoded_at_run", "test_value"] });
    expectNoReal("the agent's requests", agent.bodies.join("\n"));
    for (const [p, t] of allIn(join(repo, ".arnx"))) expectNoReal(p, t);
  }, 600_000);

  test("exec runs a stand-in as the value in the container, with no network, and its output comes back masked", async () => {
    const repo = valueRepo("exec", "version: 1\nimage: python:3.12-slim\ninstall: [pip install pytest]\n" +
      "test_command: python -m pytest -q {targets}\n");
    const yaml = "version: 1\nprojects:\n  app:\n    root: .\n    image: python:3.12-slim\n" +
      "    install: [pip install pytest]\n    test_command: python -m pytest -q {targets}\n    tests_dir: tests/arnx_generated\n";
    writeFileSync(join(repo, "tests/test_a.py"), "def test_a():\n    pass\n");
    commit(repo, "a test");
    const out = join(tmp(), "setup");
    const agent = recorded([[tool("try_project", { yaml, project: "app" })],
      [tool("exec", { project: "app", command: `echo said ${SHOWN}; grep -c ${SHOWN} shop/settings.py; printf %s ${SHOWN} | base64; ` +
        "python -c 'import socket; socket.create_connection((\"1.1.1.1\", 53), 3)' 2>&1 | tail -1" })]], "done");
    await runSetup(repo, { ...defaultSettings(), consentAt: "2026-11-04T00:00:00Z" }, agent.model, { outDir: out });
    const sent = agent.bodies.join("\n");
    expect(sent).toContain(`said ${SHOWN}\\n1\\n`);
    expect(sent).toMatch(/unreachable|OSError|timed out|No route/i);
    expectNoReal("setup's requests", sent);
    const logged = allIn(out);
    expect(logged.some(([p]) => p.endsWith("exec-1.log"))).toBe(true);
    for (const [p, t] of logged) expectNoReal(p, t);
  }, 600_000);

  test("only the project's own manifest keeps a guess in a built image; the code an install can run does not", async () => {
    const repo = initRepo(join(tmp(), "built"));
    const manifest = `# ${Date.now()}\n[tool.shop]\napi_token = "${GUESS}"\n`;
    mkdirSync(join(repo, "shop"));
    mkdirSync(join(repo, "examples/demo"), { recursive: true });
    writeFileSync(join(repo, "pyproject.toml"), manifest);
    writeFileSync(join(repo, "shop/mfst.py"), `api_token = "${GUESS}"\n`);
    writeFileSync(join(repo, "examples/demo/pyproject.toml"), `[x]\napi_token = "${GUESS}"\n`);
    mkdirSync(dirname(reviewConfigPath(repo)));
    const yaml = "version: 1\nimage: python:3.12-slim\ninstall: [\"true\"]\ntest_command: python -m pytest -q {targets}\n";
    writeFileSync(reviewConfigPath(repo), stamp(parseReviewConfig(yaml), "Dev", "2026-11-04"));
    commit(repo, "the code");
    const snap = join(tmp(), "snap");
    takeSnapshot(repo, null, snap, []);
    const image = await ensureEnv(parseReviewConfig(yaml), snap, join(tmp(), "build.log"));
    const inImage = (path: string) => docker(["run", "--rm", "--network", "none", image, "cat", path]).stdout;
    expect(inImage("/src/pyproject.toml")).toBe(manifest);
    expect(inImage("/src/shop/mfst.py")).toMatch(/^api_token = "[A-Za-z0-9]{16}"\n$/);
    expect(inImage("/src/shop/mfst.py")).not.toContain(GUESS);
    expect(inImage("/src/examples/demo/pyproject.toml")).not.toContain(GUESS);
    // Where tests run it is the code as written.
    expect(readFileSync(join(snap, "shop/mfst.py"), "utf8")).toContain(GUESS);
  }, 600_000);

  // arnx's Python hook (reached.ts) must change no test's outcome: every test, the project's own sitecustomize and
  // PYTHONPATH, and its coverage numbers are the same with it as without it, under xdist, on Pythons with and without
  // sys.monitoring.
  for (const image of ["python:3.12-slim", "python:3.11-slim"]) {
    test(`the run hook notes what pytest ran and changes nothing a test sees, under xdist and coverage (${image})`, async () => {
      const snap = join(tmp(), "reach");
      writeReachProject(snap);
      const cfg = parseReviewConfig(`version: 1\nimage: ${image}\ninstall: [pip install -r requirements.txt]\n` +
        "test_command: python -m pytest -q -n 2 --cov=app --cov-report=term {targets}\nenv:\n  PYTHONPATH: /src/own\n");
      const outcomes = (results: TestResult[] | null) =>
        Object.fromEntries((results ?? []).map((t) => [t.testId, t.outcome]));
      const total = (output: string) => /^TOTAL\s.*$/m.exec(output)?.[0];
      const times: Record<"plain" | "hook", number[]> = { plain: [], hook: [] };
      await dockerSession(cfg, snap, join(tmp(), "build.log"), async (s) => {
        for (let i = 0; i < 3; i++) {
          clearReach(snap);
          const [hooked, withHook] = await runTests(s, snap, cfg, ["tests"], "hook.xml", 600);
          const reach = readReach(snap);
          const command = python.command(cfg.testCommand, ["tests"], "/src/.arnx-run/plain.xml", "pytest");
          expect(command.startsWith("export PYTHONPATH=")).toBe(true);
          const plain = await s.run(command.slice(command.indexOf("; ") + 2), 600);
          const without = python.parseReport(readFileSync(join(snap, ".arnx-run", "plain.xml"), "utf8"), "pytest", ".");
          expect(outcomes(withHook)).toEqual(outcomes(without));
          expect(Object.values(outcomes(without)).sort()).toEqual(["failed", ...Array(5).fill("passed")]);
          expect(total(hooked.output)).toBeTruthy();
          expect(total(hooked.output)).toBe(total(plain.output));
          // Notes from the controller, both workers and a test's own subprocess.
          expect(readdirSync(join(snap, ".arnx-run")).filter((n) => /^reached-\d+\.txt$/.test(n)).length).toBeGreaterThanOrEqual(3);
          const seen = Object.fromEntries(reach);
          const sysmon = image.includes("3.12");
          // helper.py is only reached through core.py; unused.py by nothing.
          expect(seen["app/core.py"]).toBe(sysmon ? "ran" : "loaded");
          expect(seen["app/helper.py"]).toBe(sysmon ? "ran" : "loaded");
          expect(seen["app/unused.py"]).toBeUndefined();
          expect(Object.keys(seen).every((p) => !p.startsWith(".arnx-run/") && !p.includes("site-packages"))).toBe(true);
          times.hook.push(hooked.seconds);
          times.plain.push(plain.seconds);
        }
      });
      const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[1]!;
      console.log(`run hook on ${image}: ${median(times.hook).toFixed(2)} s with it, ${median(times.plain).toFixed(2)} s ` +
        `without (median of 3)`);
    }, 900_000);
  }

  test("a review does not list a changed file a test only reached through other code, and still lists one conftest loads", async () => {
    const repo = initRepo(join(tmp(), "reachrev"));
    writeReachProject(repo);
    rmSync(join(repo, "tests", "test_a.py"));
    mkdirSync(dirname(reviewConfigPath(repo)));
    writeFileSync(reviewConfigPath(repo), "version: 1\nimage: python:3.12-slim\ninstall: [pip install -r " +
      "requirements.txt]\ntest_command: python -m pytest -q -n 2 {targets}\n");
    commit(repo, "app");
    const [ok] = await approveConfig(repo, { by: "Dev", at: "2026-11-05" });
    expect(ok).toBe(true);
    for (const f of ["core", "helper", "base", "unused"]) appendFileSync(join(repo, "app", `${f}.py`), "\n\nCHANGED = 1\n");
    commit(repo, "a change");
    const gen = "tests/arnx_generated/test_total.py";
    const done = text('{"tests": [], "suspected_defects": [], "questions": []}');
    const agent = new ScriptedAgent([
      [tool("write_file", { path: gen, content: "import app.core\n\n\ndef test_total():\n    assert app.core.total([1, 2]) == 3\n" })],
      [done], [done], [done],
    ]);
    const settings = { ...defaultSettings(), consentAt: "2026-11-05T00:00:00Z", fixProofMax: 0 };
    const { review } = await runReview(repo, { settings, agentModel: agent, challenger: new FakeJson([]) });
    expect(review.missingRuns).toBe(0);
    expect(review.passed).toBe(1);
    // By name alone, helper.py would be listed too.
    expect(review.untested![0]!.files.sort()).toEqual(["app/base.py", "app/unused.py"]);
  }, 900_000);
});

/** A small project for the run hook: app/core.py calls app/helper.py, conftest loads app/base.py, nothing reaches
 * app/unused.py; its own sitecustomize is on its PYTHONPATH (/src/own). */
function writeReachProject(root: string): void {
  const files: Record<string, string> = {
    "requirements.txt": "pytest>=8,<9\npytest-xdist\npytest-cov\n",
    "app/__init__.py": "",
    "app/core.py": "from app import helper\n\n\ndef total(xs):\n    return helper.add_all(xs)\n",
    "app/helper.py": "def add_all(xs):\n    s = 0\n    for x in xs:\n        s += x\n    return s\n",
    "app/base.py": "LIMIT = 3\n\n\ndef limit():\n    return LIMIT\n",
    "app/unused.py": "def never():\n    return 1\n",
    "conftest.py": "import app.base\n",
    "own/sitecustomize.py": "import os\nos.environ[\"OWN_SITECUSTOMIZE\"] = \"ran\"\n",
    "tests/test_a.py": [
      "import os", "import subprocess", "import sys", "", "import app.core", "", "",
      "def test_total():", "    assert app.core.total([1, 2]) == 3", "", "",
      "def test_fails():", "    assert app.core.total([1]) == 2", "", "",
      "def test_own_sitecustomize_ran():", "    assert os.environ.get(\"OWN_SITECUSTOMIZE\") == \"ran\"",
      "    assert sys.modules[\"sitecustomize\"].__file__ == \"/src/own/sitecustomize.py\"", "", "",
      "def test_own_pythonpath():", "    assert \"/src/own\" in sys.path", "", "",
      "def test_subprocess():",
      "    out = subprocess.run([sys.executable, \"-c\", \"import app.base; print(app.base.limit())\"], capture_output=True, text=True)",
      "    assert out.stdout.strip() == \"3\", out.stderr", "", "",
      "def test_no_hook_output():",
      "    out = subprocess.run([sys.executable, \"-c\", \"pass\"], capture_output=True, text=True)",
      "    assert out.stdout == \"\" and out.stderr == \"\"", "",
    ].join("\n"),
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
}
