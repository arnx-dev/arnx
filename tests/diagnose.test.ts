// Hints from failures: each signature against messages real runners wrote (tests/fixtures/failures.json, from
// pytest 7 and node:test through arnx's reporter), and the failures that must get no hint.
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestResult } from "../src/adapters/types";
import { parseReviewConfig } from "../src/config";
import { classify, describeHints, diagnose, passingApart, unexplainedFiles } from "../src/diagnose";
import { envValue } from "../src/secrets";
import { useTmp } from "./helpers/tmp";
import { CFG } from "./helpers/yaml";

const tmp = useTmp();
const REAL: Record<string, string> = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/failures.json"), "utf8"));
const PY = parseReviewConfig(CFG);
const NODE = parseReviewConfig(CFG.replace("image: python:3.12-slim", "image: node:22\nlanguage: typescript")
  .replace("python -m pytest -q {targets}", "npx vitest run {targets}"));
const kind = (key: string, cfg = PY, snap = tmp()) => classify(REAL[key]!, cfg, snap);

test("a module that is not anywhere in the repository is a missing package", () => {
  expect(kind("pytest:test_missing_module")).toMatchObject({ kind: "missing-package", detail: "fancyfmt_not_installed" });
  expect(kind("pytest:tests.test_collect")).toMatchObject({ kind: "missing-package", detail: "not_a_real_package_arnx" });
  expect(kind("node:missing package", NODE)).toMatchObject({ kind: "missing-package",
    detail: "left-pad-not-installed-arnx" });
});

test("a module that is in the repository is an import path problem, not a missing package", () => {
  const snap = tmp();
  mkdirSync(join(snap, "fancyfmt_not_installed"));
  expect(kind("pytest:test_missing_module", PY, snap)?.kind).toBe("import-path");
  writeFileSync(join(snap, "not_a_real_package_arnx.py"), "");
  expect(kind("pytest:tests.test_collect", PY, snap)?.kind).toBe("import-path");
  expect(kind("node:missing relative", NODE)?.kind).toBe("import-path");
});

test("a variable is missing only when the environment raised, not any KeyError", () => {
  expect(kind("pytest:test_env_keyerror")).toMatchObject({ kind: "missing-variable", detail: "REDIS_PORT_ARNX" });
  expect(kind("pytest:test_env_int_none")).toMatchObject({ kind: "missing-variable", detail: "WORKER_COUNT_ARNX" });
  expect(kind("pytest:test_dict_keyerror")).toBeNull();
});

test("a variable env sets is the cause only when the error line names it", () => {
  const cfg = parseReviewConfig(CFG.replace("env: {MODE: test}",
    "env: {MODE: test, PAY_LINK_SECRET: x}\nallow_env_names: [PAY_LINK_SECRET]"));
  const raised = "RuntimeError: PAY_LINK_SECRET must be set to at least 32 characters\n" +
    "tests/test_credits.py:12: in test_grant\n    secret = os.environ['PAY_LINK_SECRET']";
  expect(classify(raised, cfg, tmp())).toMatchObject({ kind: "env-value", detail: "PAY_LINK_SECRET",
    evidence: "RuntimeError: PAY_LINK_SECRET must be set to at least 32 characters" });
  // Named only in the source lines the traceback prints, by a longer name, or a name env does not set: no hint.
  expect(classify("assert 500 == 200\n    secret = os.environ['PAY_LINK_SECRET']", cfg, tmp())).toBeNull();
  expect(classify("RuntimeError: PAY_LINK_SECRET_V2 must be set", cfg, tmp())).toBeNull();
  expect(classify("RuntimeError: PAY_LINK_SECRET must be set", PY, tmp())).toBeNull();
  // A short key is never looked for: it would match ordinary words in errors.
  const short = parseReviewConfig(CFG.replace("env: {MODE: test}", "env: {DB: x}"));
  expect(classify("ValueError: DB x", short, tmp())).toBeNull();
  expect(describeHints(diagnose([{ testId: "tests/test_credits.py::test_grant", name: "test_grant",
    fileAttr: "tests/test_credits.py", outcome: "failed", message: raised } as TestResult], cfg, tmp()), cfg))
    .toContain("variable `PAY_LINK_SECRET`, which env sets");
});

test("a variable env sets is the cause when the error line quotes its value as a whole token", () => {
  const cfg = parseReviewConfig(CFG.replace("env: {MODE: test}",
    "env: {MODE: test, DB_HOST: mongo, CACHE_HOST: unused.invalid, PORT_X: '8080', FLAG_X: 'true', ZONE_X: abc}"));
  const host = (v: string) => `pymongo.errors.ConfigurationError: Invalid URI host: ${v} is not a valid hostname ` +
    "for 'mongodb+srv://'. Did you mean to use 'mongodb://'?\n    client = MongoClient(f'mongodb+srv://u:p@{host}')";
  expect(classify(host("mongo"), cfg, tmp())).toMatchObject({ kind: "env-value", detail: "DB_HOST",
    evidence: expect.stringContaining("Invalid URI host: mongo is") });
  expect(classify(host("unused.invalid"), cfg, tmp())).toMatchObject({ kind: "env-value", detail: "CACHE_HOST" });
  // Inside a longer word, only in the traceback's source lines, or on a KeyError: no hint.
  expect(classify("pymongo.errors.ConfigurationError: bad scheme mongodb+srv", cfg, tmp())).toBeNull();
  expect(classify("assert 500 == 200\n    url = 'http://mongo:27017'", cfg, tmp())).toBeNull();
  expect(classify("KeyError: 'mongo'", cfg, tmp())).toBeNull();
  // A short value, a number, or a word any line may hold is never looked for.
  expect(classify("ValueError: zone abc is not known", cfg, tmp())).toBeNull();
  expect(classify("ValueError: port 8080 is in use", cfg, tmp())).toBeNull();
  expect(classify("AssertionError: assert true is false", cfg, tmp())).toBeNull();
  expect(classify("AssertionError: expected test to pass", cfg, tmp())).toBeNull();
  expect(describeHints(diagnose([{ testId: "tests/test_db.py::test_find", name: "test_find",
    fileAttr: "tests/test_db.py", outcome: "failed", message: host("mongo") } as TestResult], cfg, tmp()), cfg))
    .toContain("variable `DB_HOST`, which env sets");
});

test("a value arnx generates for env counts as the value env sets", () => {
  const cfg = parseReviewConfig(CFG.replace("env: {MODE: test}", "env: {MODE: test, SIGNING_KEY: arnx:generated}"));
  expect(classify(`ValueError: key ${envValue("arnx:generated")} must be 32 bytes`, cfg, tmp()))
    .toMatchObject({ kind: "env-value", detail: "SIGNING_KEY" });
});

test("hosts that do not resolve, and connections refused", () => {
  expect(kind("pytest:test_dns_external")).toMatchObject({ kind: "unresolved-host", detail: "" });
  expect(kind("pytest:test_dns_bare")).toMatchObject({ kind: "unresolved-host", detail: "" });
  expect(kind("node:dns", NODE)).toMatchObject({ kind: "unresolved-host", detail: "api.example.net" });
  // Libraries as a sandbox meets them: requests, psycopg to an undeclared host, pymongo's mongodb+srv lookup.
  for (const key of ["pytest:test_requests_external", "pytest:test_psycopg_named", "pytest:test_mongo_srv"]) {
    expect([key, kind(key)?.kind]).toEqual([key, "unresolved-host"]);
  }
  expect(kind("pytest:test_refused_local")?.kind).toBe("connection-refused");
  expect(kind("node:refused", NODE)).toMatchObject({ kind: "connection-refused", detail: "127.0.0.1:59999" });
});

test("failures with no signature get no hint", () => {
  for (const key of ["pytest:test_real_bug", "pytest:test_dict_keyerror", "pytest:test_bug_keyerror_payload",
    "node:fetch", "node:env"]) {
    expect([key, kind(key, key.startsWith("node") ? NODE : PY)]).toEqual([key, null]);
  }
});

test("a declared service is never called the internet", () => {
  const withDb = parseReviewConfig(CFG + "services:\n  db: {image: postgres:16-alpine}\n");
  expect(classify("Error: getaddrinfo ENOTFOUND db", withDb, tmp())).toBeNull();
  const h = classify("Error: connect ECONNREFUSED db:5432", withDb, tmp())!;
  expect(describeHints([{ ...h, files: ["t.py"] }], withDb)).toContain("service `db` refuses connections");
  const local = classify(REAL["node:refused"]!, NODE, tmp())!;
  expect(describeHints([{ ...local, files: ["t.mjs"] }], NODE)).toContain("expects a server on localhost");
});

const r = (fileAttr: string, outcome: string, message = ""): TestResult =>
  ({ testId: `${fileAttr}::t`, fileAttr, name: "t", outcome, message });

test("hints group by kind and detail, leave known_failing out, and quote their line", () => {
  const cfg = parseReviewConfig(CFG + "known_failing: [tests/test_old.py]\n");
  const results = [r("tests/a.py", "failed", REAL["pytest:test_missing_module"]),
    r("tests/b.py", "error", REAL["pytest:test_missing_module"]), r("tests/test_old.py", "failed",
      REAL["pytest:test_env_keyerror"]), r("tests/c.py", "failed", REAL["pytest:test_real_bug"]), r("tests/d.py", "passed")];
  const hints = diagnose(results, cfg, tmp());
  expect(hints).toEqual([{ kind: "missing-package", detail: "fancyfmt_not_installed", files: ["tests/a.py", "tests/b.py"],
    evidence: "ModuleNotFoundError: No module named 'fancyfmt_not_installed'" }]);
  expect(describeHints(hints, cfg)).toContain("Files: tests/a.py, tests/b.py. From: \"ModuleNotFoundError");
  // Only the failure no hint explains is worth running apart from the suite.
  expect(unexplainedFiles(results, cfg, hints)).toEqual(["tests/c.py"]);
});

test("files pass apart only when every one of their tests passes or is skipped", () => {
  const apart = [r("a.py", "passed"), r("a.py", "skipped"), r("b.py", "passed"), r("b.py", "failed")];
  expect(passingApart(["a.py", "b.py", "c.py"], apart)).toEqual(["a.py"]);
  expect(passingApart(["a.py"], null)).toEqual([]);
});
