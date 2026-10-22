import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isApproved, loadReviewConfig, parseReviewConfig, reviewConfigPath, stamp } from "../src/config";
import { ArnxError, SetupRequired } from "../src/errors";
import { GOOD } from "./helpers/yaml";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();

test("test_parse_good", () => {
  const cfg = parseReviewConfig(GOOD);
  expect(cfg.workdir).toBe("app");
  expect(cfg.testsDir).toBe("tests/arnx_generated");
  expect(cfg.services[0]!.name).toBe("postgres");
  expect(cfg.services[0]!.ready).toBe("pg_isready -U postgres");
  expect(cfg.env).toEqual({ DATABASE_URL: "postgresql://postgres@postgres:5432/postgres" });
  expect(isApproved(cfg)).toBe(false);
});

test.each([
  ["version", GOOD.replace("version: 1", "version: 2"), /version/],
  ["test_command", GOOD.replace("{targets}", ""), /test_command/],
  ["workdir", GOOD.replace("workdir: app", "workdir: ../up"), /workdir/],
  ["unknown keys: colour", GOOD.replace("notes:", "colour: blue\nnotes:"), /unknown keys: colour/],
  ["env.STRIPE_API_KEY", GOOD.replace("DATABASE_URL:", "STRIPE_API_KEY: x\n  DATABASE_URL:"), /env\.STRIPE_API_KEY/],
  ["install", GOOD.replace("  - pip install", "  - |\n    pip install"), /install/],
] as const)("test_parse_bad[%s]", (_id, bad, message) => {
  expect(() => parseReviewConfig(bad)).toThrow(ArnxError);
  expect(() => parseReviewConfig(bad)).toThrow(message);
});

test("test_allow_env_names", () => {
  const text = GOOD.replace("DATABASE_URL:", "DB_PASSWORD: throwaway\n  DATABASE_URL:") + "allow_env_names: [DB_PASSWORD]\n";
  expect(parseReviewConfig(text).env.DB_PASSWORD).toBe("throwaway");
});

test("test_stamp_and_tamper", () => {
  const path = reviewConfigPath(tmp());
  mkdirSync(dirname(path));
  writeFileSync(path, GOOD);
  expect(() => loadReviewConfig(tmp())).toThrow(SetupRequired);
  expect(() => loadReviewConfig(tmp())).toThrow(/arnx approve/);
  writeFileSync(path, stamp(parseReviewConfig(GOOD), "dev", "2026-10-10"));
  expect(isApproved(loadReviewConfig(tmp()))).toBe(true);
  writeFileSync(path, readFileSync(path, "utf8").replace("pytest -q", "pytest -x -q"));
  expect(() => loadReviewConfig(tmp())).toThrow(SetupRequired);
});

test("test_missing", () => {
  expect(() => loadReviewConfig(tmp())).toThrow(SetupRequired);
  expect(() => loadReviewConfig(tmp())).toThrow(/arnx setup/);
});

test("plain scalars resolve as PyYAML does", () => {
  const cfg = parseReviewConfig(GOOD.replace("env:\n", "env:\n  A: y\n  B: 012\n  C: 2026-10-11\n  D: 09\n  E: 1e-05\n  F: on\n"));
  expect(cfg.env).toMatchObject({ A: "y", B: "10", C: "2026-10-11", D: "09", E: "1e-05", F: "True" });
});
