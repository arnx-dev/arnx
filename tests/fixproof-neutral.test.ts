// The fix proof adds to review.json and review.md and changes nothing else: the two neutrality goldens' reviews
// (scenarios copied from tests/neutral.test.ts), run with the before/after check on and the fix proof on and off,
// differ only by `fix_proof`, `timings.fix_proof_secs` and the "The change fixes" section; the findings, their
// before/after statuses and the exit code are the same; and with the check's own fields left out, each is its golden.
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseReviewConfig, parseReviewFile, reviewConfigPath, stamp, stampFile } from "../src/config";
import { runReview } from "../src/reviewer";
import type { SessionFactory } from "../src/sandbox";
import { defaultSettings } from "../src/settings";
import { FakeJson, FakeSession, ScriptedAgent, text, tool } from "./helpers/fakes";
import { commit, gitRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const NOW = new Date("2026-10-16T12:00:00Z");
const GOLDEN = join(import.meta.dir, "fixtures/golden");

type Json = Record<string, unknown>;
interface Written { json: Json; md: string }

/** As neutral.test.ts normalises, plus the check's timings (they vary from run to run). */
function written(rdir: string, root: string): Written {
  const rid = rdir.split("/").at(-1)!;
  const clean = (s: string) => s.replaceAll(rid, "<ID>").replaceAll(root, "<TMP>")
    .replace(/\(base [0-9a-f]{7,40}\)/g, "(base <SHA>)");
  const json = JSON.parse(clean(readFileSync(join(rdir, "review.json"), "utf8"))) as Json;
  json.seconds = 0;
  const timings = json.timings as Json | undefined;
  if (timings) for (const k of Object.keys(timings)) timings[k] = 0;
  const md = clean(readFileSync(join(rdir, "review.md"), "utf8"))
    .replace(/ · (\d+m\d{2}s|\d+s) · Agent stopped/, " · <S> · Agent stopped");
  return { json, md };
}

/** review.json without the fix proof's fields. */
function withoutFixProof(j: Json): Json {
  const { fix_proof: _f, ...rest } = j;
  const { fix_proof_secs: _s, ...timings } = (rest.timings ?? {}) as Json;
  return { ...rest, ...(rest.timings ? { timings } : {}) };
}

/** review.json without anything the before/after check writes: what the golden (check off) holds. */
function withoutCheck(j: Json): Json {
  const { timings: _t, before_base_empty: _b, ...rest } = withoutFixProof(j);
  return { ...rest, findings: (rest.findings as Json[]).map(({ before: _before, ...f }) => f) };
}

const SECTION = /## The change fixes\n[\s\S]*?(?=## Findings)/;

function compare(name: string, on: Written, off: Written, fixed: string[]): void {
  expect((on.json.fix_proof as Json[]).filter((x) => x.before_status === "fixed").map((x) => x.test_id))
    .toEqual(fixed);
  expect(off.json.fix_proof).toBeUndefined();
  expect(withoutFixProof(on.json)).toEqual(off.json);
  expect((on.json.findings as Json[]).map((f) => f.before)).toEqual((off.json.findings as Json[]).map((f) => f.before));
  expect((on.json.findings as Json[]).every((f) => f.before !== undefined)).toBe(true);
  expect(on.json.exit_code).toBe(off.json.exit_code);
  expect(on.md).toMatch(SECTION);
  expect(on.md.replace(SECTION, "")).toBe(off.md);
  const golden = JSON.parse(readFileSync(join(GOLDEN, `neutral-${name}.review.json`), "utf8")) as Json;
  expect(withoutCheck(on.json)).toEqual(golden);
}

const settings = (fixProofMax: number, consentAt: string) =>
  ({ ...defaultSettings(), beforeCheck: true, fixProofMax, consentAt });

async function hunt(fixProofMax: number): Promise<Written> {
  const root = tmp(), repo = gitRepo(join(root, String(fixProofMax)));
  const GEN = "tests/arnx_generated/test_x.py";
  mkdirSync(join(repo, "svc"), { recursive: true });
  writeFileSync(join(repo, "svc/calc.py"), "def spread(xs):\n    return 0\n");
  mkdirSync(join(repo, ".arnx"));
  writeFileSync(reviewConfigPath(repo), stampFile(parseReviewFile(`version: 1
projects:
  svc:
    root: svc
    image: python:3.12-slim
    test_command: python -m pytest {targets}
`), "Dev", "2026-10-12"));
  commit(repo, "layout");
  writeFileSync(join(repo, "svc/calc.py"), "def spread(xs):\n    return -0.5\n");
  // On the code before the change the finding passes (a regression, still challenged) and test_empty fails (fixed).
  const session: SessionFactory = async (_cfg, snap, _log, body) => body(new FakeSession(snap, () =>
    snap.endsWith("/before")
      ? [junitXml([[GEN, "test_spread_positive", "passed", ""], [GEN, "test_empty", "failed", "assert 1 == 0"]]), "", false]
      : [junitXml([[GEN, "test_spread_positive", "failed", "assert -0.5 >= 0"], [GEN, "test_empty", "passed", ""]]),
        "1 failed, 1 passed", false]));
  const hunter = JSON.stringify({ suspects: [
    { file: "svc/calc.py", line: 2, claim: "spread is negative", why: "returns -0.5", input: "[1, 3]", expected: "0.5",
      actual: "-0.5" },
    { file: "svc/calc.py", line: 1, claim: "empty input crashes", why: "w", input: "[]", expected: "0",
      actual: "error" }],
    questions: ["Should an empty list count as equal?"] });
  const proved = JSON.stringify({ tests: [
    { test: `${GEN}::test_spread_positive`, expects: "non-negative", suspect: "S1" },
    { test: `${GEN}::test_empty`, expects: "0", suspect: "S3" }], suspected_defects: [], questions: [],
    suspects_not_tested: [{ suspect: "S2", reason: "needs the network" }] });
  const agent = new ScriptedAgent([
    [tool("write_file", { path: `svc/${GEN}`, content: "x" })],
    [tool("read_file", { path: "svc/calc.py" })], [text(hunter)],
    [tool("write_file", { path: `svc/${GEN}`,
      content: "import calc\ndef test_spread_positive(): pass\ndef test_empty(): pass\n" })],
    [text(proved)],
    [text(proved)],
  ]);
  const second = new FakeJson([{ suspects: [{ file: "svc/calc.py", line: 2, claim: "dup", why: "", input: "",
    expected: "", actual: "" }, { file: "svc/calc.py", line: 40, claim: "far away", why: "", input: "", expected: "",
    actual: "" }], questions: [] }, { verdict: "confirmed", reason: "sign" }]);
  const { rdir } = await runReview(repo, { settings: settings(fixProofMax, "2026-10-12T00:00:00Z"), agentModel: agent,
    challenger: second, sessionFactory: session, hunt: true, now: NOW });
  return written(rdir, join(root, String(fixProofMax)));
}

async function plain(fixProofMax: number): Promise<Written> {
  const root = tmp(), repo = gitRepo(join(root, String(fixProofMax)));
  const path = reviewConfigPath(repo);
  mkdirSync(dirname(path));
  writeFileSync(path, stamp(parseReviewConfig("version: 1\nimage: python:3.12-slim\n" +
    "test_command: python -m pytest -q {targets}\n"), "Dev", "2026-10-11"));
  writeFileSync(join(repo, "app.py"), "def add(a, b):\n    return a - b\n");
  const gen = "tests/arnx_generated/test_add.py";
  const report = '{"tests": [{"test": "tests/arnx_generated/test_add.py::test_add", "expects": "add sums"},' +
    ' {"test": "tests/arnx_generated/test_add.py::test_zero", "expects": "zero is neutral"}],' +
    ' "suspected_defects": [{"test": "tests/arnx_generated/test_add.py::test_add",' +
    ' "explanation": "add subtracts instead of adding."}],' +
    ' "questions": ["Should add accept strings?"]}';
  const agent = new ScriptedAgent([
    [tool("write_file", { path: gen, content: "from app import add\n\ndef test_add():\n    assert add(2, 3) == 5\n" +
      "\ndef test_zero():\n    assert add(0, 0) == 0\n" })],
    [text(report)],
  ]);
  const session: SessionFactory = async (_cfg, snap, _log, body) => body(new FakeSession(snap, () =>
    snap.endsWith("/before")
      ? [junitXml([[gen, "test_add", "passed", ""], [gen, "test_zero", "failed", "assert 1 == 0"]]), "", false]
      : [junitXml([[gen, "test_add", "failed", "assert -1 == 5"], [gen, "test_zero", "passed", ""]]), "", false]));
  const judge = new FakeJson([{ verdict: "confirmed", reason: "add subtracts." }]);
  const { rdir } = await runReview(repo, { settings: settings(fixProofMax, "2026-10-11T00:00:00Z"), agentModel: agent,
    challenger: judge, sessionFactory: session, now: NOW });
  return written(rdir, join(root, String(fixProofMax)));
}

test("hunt golden: the fix proof only adds its own fields", async () => {
  compare("hunt", await hunt(20), await hunt(0), ["tests/arnx_generated/test_x.py::test_empty"]);
});

test("plain golden: the fix proof only adds its own fields", async () => {
  compare("plain", await plain(20), await plain(0), ["tests/arnx_generated/test_add.py::test_zero"]);
});
