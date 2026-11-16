// Pins every file under .arnx/tests/ as accept would, so check places it: an entry without a test list (as an older
// arnx wrote), where every test in the file counts as accepted.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function pinKept(repo: string, review = ""): void {
  const files: Record<string, { sha256: string; review: string }> = {};
  const walk = (rel: string) => {
    for (const name of readdirSync(join(repo, rel))) {
      const p = `${rel}/${name}`;
      if (statSync(join(repo, p)).isDirectory()) walk(p);
      else files[p] = { sha256: createHash("sha256").update(readFileSync(join(repo, p))).digest("hex"), review };
    }
  };
  if (existsSync(join(repo, ".arnx/tests"))) walk(".arnx/tests");
  writeFileSync(join(repo, ".arnx/accepted-tests.json"), JSON.stringify({ schema_version: 1, files }, null, 2) + "\n");
}
