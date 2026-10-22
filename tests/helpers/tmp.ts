import { afterEach, beforeEach } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A fresh temporary directory per test (pytest's tmp_path). Call at the top of a test file or describe block. */
export function useTmp(): () => string {
  let dir = "";
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "arnx-test-")));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return () => dir;
}
