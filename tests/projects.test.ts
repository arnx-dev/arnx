import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  fileDigest, isFileApproved, loadReviewFile, parseReviewConfig, parseReviewFile, projectDigest, reviewConfigPath,
  stampFile,
} from "../src/config";
import { ArnxError } from "../src/errors";
import { golden } from "./helpers/golden";
import { useTmp } from "./helpers/tmp";
import { GOOD, PROJECTS } from "./helpers/yaml";

const tmp = useTmp();

test("a file without projects is one project named main", () => {
  const f = parseReviewFile(GOOD);
  expect(f.legacy).toBe(true);
  expect(f.projects.map((p) => [p.name, p.workdir, p.runner, p.owns, p.uses]))
    .toEqual([["main", "app", "pytest", ["**"], []]]);
  expect(fileDigest(parseReviewFile(golden("yaml-good.yaml")))).toBe(golden("digest-good.txt"));
  expect(isFileApproved(parseReviewFile(golden("stamped-good.yaml")))).toBe(true);
});

test("projects parse with roots, defaults and their own services", () => {
  const f = parseReviewFile(PROJECTS);
  expect(f.legacy).toBe(false);
  const [pay, feed] = f.projects;
  expect([pay!.name, pay!.workdir, pay!.owns, pay!.uses]).toEqual(["pay", "services/pay", ["/services/pay/"],
    ["services/shared/"]]);
  expect(pay!.services.map((s) => s.name)).toEqual(["db"]);
  expect(feed!.services.map((s) => s.name)).toEqual(["db", "mq"]);
  expect(pay!.testsDir).toBe("tests/arnx_generated");
  expect(pay!.raw).toBe(f.raw);
  expect(f.uncovered).toEqual([{ path: "infra/", reason: "Terraform; no adapter" }]);
  expect(f.services.map((s) => s.name)).toEqual(["db", "mq"]);
});

test.each([
  ["unknown project key", PROJECTS.replace("    uses: [services/shared/]\n  feed:", "    colour: x\n  feed:"),
    /projects\.pay: unknown keys: colour/],
  ["bad project name", PROJECTS.replace("  pay:", "  Pay_1:"), /projects\.Pay_1/],
  ["undefined service", PROJECTS.replace("services: [db]", "services: [cache]"), /projects\.pay\.services: cache/],
  ["unknown runner", PROJECTS.replace("    language: python\n    image: python:3.12-slim\n    install",
    "    language: python\n    runner: nose\n    image: python:3.12-slim\n    install"), /projects\.pay\.runner/],
  ["legacy keys mixed in", PROJECTS + "image: x\n", /unknown keys: image/],
  ["secret env in a project", PROJECTS.replace("DATABASE_URL:", "API_TOKEN: x, DATABASE_URL:"),
    /projects\.pay\.env\.API_TOKEN/],
  ["bad uncovered entry", PROJECTS.replace("{path: infra/, reason: Terraform; no adapter}", "infra/"), /uncovered/],
  ["no projects", "version: 1\nprojects: {}\n", /projects: at least one/],
] as const)("projects file refused: %s", (_name, text, message) => {
  expect(() => parseReviewFile(text)).toThrow(ArnxError);
  expect(() => parseReviewFile(text)).toThrow(message);
});

test("parseReviewConfig still reads legacy files and refuses project files", () => {
  expect(parseReviewConfig(GOOD).name).toBe("main");
  expect(() => parseReviewConfig(PROJECTS)).toThrow(/projects/);
});

test("stamp, approval and per-project digests", () => {
  const f = parseReviewFile(PROJECTS);
  const path = reviewConfigPath(tmp());
  mkdirSync(join(tmp(), ".arnx"));
  writeFileSync(path, stampFile(f, "Dev", "2026-10-12T00:00:00+00:00"));
  const loaded = loadReviewFile(tmp());
  expect(isFileApproved(loaded)).toBe(true);
  const stamp = loaded.raw.approved as { projects: Record<string, string> };
  expect(stamp.projects).toEqual({ pay: projectDigest(f, "pay"), feed: projectDigest(f, "feed") });
  const changedFeed = parseReviewFile(PROJECTS.replace("services: [db, mq]", "services: [db]"));
  expect(projectDigest(changedFeed, "pay")).toBe(projectDigest(f, "pay"));
  expect(projectDigest(changedFeed, "feed")).not.toBe(projectDigest(f, "feed"));
  const changedDb = parseReviewFile(PROJECTS.replace("postgres:16", "postgres:17"));
  expect(projectDigest(changedDb, "pay")).not.toBe(projectDigest(f, "pay"));
  expect(() => loadReviewFile(join(tmp(), "nope"))).toThrow(/arnx setup/);
});
