// Byte-for-byte parity with files captured from the Python version of arnx (tests/fixtures/golden).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { python } from "../src/adapters/python";
import { digest, isApproved, parseReviewConfig, stamp } from "../src/config";
import { answerTask, challengeUser, reviewSystem, reviewTask } from "../src/prompts";
import { load, render, summary } from "../src/report";
import { dockerfile, envKey } from "../src/sandbox";
import { defaultSettings, writeSettings } from "../src/settings";
import { ROUND_CFG, CFG as SANDBOX_CFG } from "./helpers/yaml";
import { GOLDEN, golden } from "./helpers/golden";
import { sampleReview } from "./helpers/review";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();

test("golden: config.toml", () => {
  writeSettings(tmp(), { ...defaultSettings(), consentAt: "2026-10-10T12:00:00+00:00",
    prices: { "some-model": [1.0, 2.0, 0.1, 0.0] } }, { known: true }); // as init writes it
  expect(readFileSync(join(tmp(), ".arnx", "config.toml"), "utf8")).toBe(golden("config.toml"));
});

test("golden: review.yaml digests match Python's", () => {
  expect(digest(parseReviewConfig(golden("yaml-good.yaml")))).toBe(golden("digest-good.txt"));
  expect(digest(parseReviewConfig(golden("yaml-mixed.yaml")))).toBe(golden("digest-mixed.txt"));
});

test("golden: a review.yaml stamped by Python is approved", () => {
  const cfg = parseReviewConfig(golden("stamped-good.yaml"));
  expect(isApproved(cfg)).toBe(true);
  expect(digest(cfg)).toBe(golden("digest-good.txt"));
});

test("golden: a TypeScript stamp re-parses with Python's digest", () => {
  const cfg = parseReviewConfig(stamp(parseReviewConfig(golden("yaml-mixed.yaml")), "Dev", "2026-10-11T00:00:00+00:00"));
  expect(isApproved(cfg)).toBe(true);
  expect(digest(cfg)).toBe(golden("digest-mixed.txt"));
});

test("golden: env image key, Dockerfile and run command match Python's", () => {
  const cfg = parseReviewConfig(SANDBOX_CFG);
  expect(envKey(cfg, join(GOLDEN, "envkey"))).toBe(golden("envkey.txt"));
  expect(dockerfile(cfg)).toBe(golden("dockerfile.txt"));
  expect(python.command(cfg.testCommand, ["tests/x y.py", "a'b"], "/src/.arnx-run/final-1.xml", "pytest"))
    .toBe(golden("pytest-command.txt"));
});

test("golden: prompts match Python's byte for byte", () => {
  const cfg = parseReviewConfig(ROUND_CFG);
  const diff = "diff --git a/x b/x\n+$weird {braces}\n";
  expect(reviewSystem(cfg)).toBe(golden("review-system.txt"));
  expect(reviewTask(cfg, diff, 5)).toBe(golden("review-task.txt"));
  expect(answerTask(cfg, "Should X?", "Yes.", diff)).toBe(golden("answer-task.txt"));
  expect(challengeUser("d", "app/t.py", "def test_1(): ...", "t.py::test_1", "assert 1 == 2", ""))
    .toBe(golden("challenge-user.txt"));
});

test("golden: review.md and the summary (layout changed on purpose in batch 2; Python parity before that)", () => {
  expect(render(sampleReview())).toBe(golden("render.md"));
  expect(summary(sampleReview(), ".arnx/reviews/x/review.md")).toBe(golden("summary.txt"));
});

test("golden: a review.json written by Python loads", () => {
  expect(load(join(GOLDEN, "review"))).toEqual(sampleReview());
});
