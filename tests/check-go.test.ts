// check on a Go module: accept keeps each test as tests/arnx/r<tag>/<name>_arnx/<name>_arnx_test.go, one folder per
// file, and check must run exactly those packages, not the module's own tests nor a generated file left behind.
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { go } from "../src/adapters/go";
import { check } from "../src/check";
import { parseReviewFile, reviewConfigPath, stampFile } from "../src/config";
import type { Runner, RunResult, SessionFactory } from "../src/sandbox";
import { defaultSettings } from "../src/settings";
import { isKeptPath } from "../src/testround";
import { commit, gitRepo } from "./helpers/gitutil";
import { pinKept } from "./helpers/pins";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const SETTINGS = { ...defaultSettings(), consentAt: "2026-10-12T00:00:00Z" };
const CONFIG = `version: 1
projects:
  calc:
    root: calc
    language: go
    runner: gotest
    image: golang:1.26-bookworm
    test_command: go test {targets}
`;
const TAG = "20261109_abc123";
// The names accept gives (the same function accept calls).
const RUN = go.acceptedPath("adds_arnx_test.go", TAG, "tests/arnx", "adds");
const KEPT = posix.join("calc", RUN);

/** What `go test -json`, with the adapter's trailer, writes for one passing test in `run`'s package. */
function report(run: string): string {
  const pkg = `example.com/calc/${posix.dirname(run)}`;
  return [{ Action: "run", Package: pkg, Test: "TestAdds" }, { Action: "pass", Package: pkg, Test: "TestAdds" },
    { Action: "pass", Package: pkg }].map((e) => JSON.stringify(e)).join("\n") +
    `\n#arnx-module example.com/calc\n#arnx-test ${run}:func TestAdds(t *testing.T) {\n`;
}

test("check runs the package accept kept in a Go module, and only that", async () => {
  expect(RUN).toBe(`tests/arnx/r${TAG}/adds_arnx/adds_arnx_test.go`);
  const repo = gitRepo(tmp());
  mkdirSync(join(repo, "calc/arnx_generated/left_arnx"), { recursive: true });
  mkdirSync(join(repo, ".arnx/tests", dirname(KEPT)), { recursive: true });
  // Stored with .arnx appended: go test never builds it there.
  writeFileSync(join(repo, ".arnx/tests", `${KEPT}.arnx`), "package arnx\n");
  writeFileSync(join(repo, "calc/go.mod"), "module example.com/calc\n\ngo 1.24\n");
  writeFileSync(join(repo, "calc/calc_test.go"), "package calc\n"); // the module's own
  writeFileSync(join(repo, "calc/arnx_generated/left_arnx/left_arnx_test.go"), "package arnx\n"); // a round's leftover
  writeFileSync(reviewConfigPath(repo), stampFile(parseReviewFile(CONFIG), "Dev", "2026-11-09"));
  pinKept(repo);
  commit(repo, "layout");
  const commands: string[] = [];
  const session: SessionFactory = async (_c, snap, _l, body) => body({
    run(command: string): RunResult {
      commands.push(command);
      const out = /> '?\/src\/([^' ;]+)/.exec(command)![1]!;
      mkdirSync(dirname(join(snap, out)), { recursive: true });
      writeFileSync(join(snap, out), report(RUN));
      return { exitCode: 0, output: "", timedOut: false, seconds: 0.1 };
    },
  } as Runner);
  const [calc, ...others] = await check(repo, SETTINGS, { sessionFactory: session });
  expect(others).toEqual([]);
  expect(calc!.files).toEqual([`.arnx/tests/${KEPT}.arnx`]);
  expect(calc!.passed).toEqual([`${RUN}::TestAdds`]);
  expect(commands).toHaveLength(1);
  expect(commands[0]).toContain(`-json -count=1 -vet=off ./tests/arnx/r${TAG}/adds_arnx `);
  expect(commands[0]).not.toContain("./...");
  expect(commands[0]).not.toContain("left_arnx");
  expect(commands[0]).not.toContain("calc_test");
});

test("setup counts a Go module's kept tests as accepted, not its own tests or generated files", () => {
  const cfg = parseReviewFile(CONFIG).projects[0]!;
  expect(isKeptPath(cfg, KEPT)).toBe(true);
  expect(isKeptPath(cfg, "calc/calc_test.go")).toBe(false);
  expect(isKeptPath(cfg, "calc/arnx_generated/left_arnx/left_arnx_test.go")).toBe(false);
  expect(isKeptPath(cfg, "other/tests/arnx/r20261109_abc123/adds_arnx/adds_arnx_test.go")).toBe(false);
});
