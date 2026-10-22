// Docker end to end: real sandbox and Postgres, scripted models. Run with ARNX_DOCKER_TESTS=1.
import { describe, expect, test } from "bun:test";
import { blankMarks } from "./helpers/review";
import { appendFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { accept } from "../src/accept";
import { isApproved, parseReviewConfig, reviewConfigPath } from "../src/config";
import { EVENTS_FILE } from "../src/events";
import { exitCode } from "../src/report";
import { runReview } from "../src/reviewer";
import { defaultSettings } from "../src/settings";
import { approveConfig } from "../src/setup";
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
    expect(exitCode(review)).toBe(1);
    // invite() is what the change adds: on the code before it the test cannot find it
    expect(review.findings[0]!.before!.status).toBe("new-code");
    console.log(`before/after check with Postgres: ${review.timings!.beforeCheckSecs} s of a ${review.seconds} s review`);

    const md = blankMarks(readFileSync(join(rdir, "review.md"), "utf8")).replace("Mark: [ ] real", "Mark: [x] real");
    writeFileSync(join(rdir, "review.md"), md);
    const result = await accept(repo, rdir, settings);
    // named after what it protects: the finding's explanation
    expect(result.kept.map((p) => basename(p))).toContain("test_any_member_can_invite_only_admins_should.py");
    expect(isApproved(parseReviewConfig(readFileSync(reviewConfigPath(repo), "utf8")))).toBe(true);
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
    const agent = new ScriptedAgent([
      [tool("write_file", { path: gen, content: "from calc import add, mul\n\n\ndef test_add():\n    assert add(2, 3) " +
        "== 5\n\n\ndef test_mul():\n    assert mul(2, 3) == 6\n\n\ndef test_neg():\n    from calc import neg\n" +
        "    assert neg(2) == -2\n" })],
      [text('{"tests": [], "suspected_defects": [], "questions": []}')],
      [text('{"tests": [], "suspected_defects": [], "questions": []}')], // a coverage follow-up, if asked
    ]);
    const said: string[] = [];
    const settings = { ...defaultSettings(), consentAt: "2026-10-17T00:00:00Z" };
    const { review, rdir } = await runReview(repo, { settings, agentModel: agent, progress: (m) => said.push(m),
      challenger: new FakeJson([{ verdict: "confirmed", reason: "a" }, { verdict: "confirmed", reason: "b" }]) });
    expect(review.missingRuns).toBe(0);
    expect(review.findings.map((f) => [f.func, f.before!.status])).toEqual([["test_add", "regression"],
      ["test_mul", "pre-existing"], ["test_neg", "new-code"]]);
    expect(review.findings.map((f) => f.verdict)).toEqual(["confirmed", null, "confirmed"]);
    expect(exitCode(review)).toBe(1);
    expect(said.some((m) => /before\/after check: 3 tests on the code before the change, [\d.]+ s: 1 regression, 1 pre-existing, 1 new-code/.test(m))).toBe(true);
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
    expect(md).toContain("## The change fixes");
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
    const agent = new ScriptedAgent([
      [tool("write_file", { path: gen, content: "from calc import add\n\n\ndef test_add():\n    assert add(2, 3) == 5\n" })],
      [text('{"tests": [], "suspected_defects": [], "questions": []}')],
      [text('{"tests": [], "suspected_defects": [], "questions": []}')], // a coverage follow-up, if asked
    ]);
    const settings = { ...defaultSettings(), consentAt: "2026-10-20T00:00:00Z" };
    const { review, rdir } = await runReview(repo, { settings, agentModel: agent,
      challenger: new FakeJson([{ verdict: "confirmed", reason: "add subtracts" }]) });
    expect(review.change).toBe("all files (no commits yet)");
    expect(review.missingRuns).toBe(0);
    expect(review.findings.map((f) => [f.func, f.before!.status])).toEqual([["test_add", "unknown"]]);
    expect(review.beforeBaseEmpty).toBe("first-commit");
    expect(exitCode(review)).toBe(1);
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
});
