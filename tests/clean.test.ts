// The arnx tree must be publishable as it is: no private names, no imports outside node: built-ins and the declared
// dependencies, an Apache 2.0 licence.
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(import.meta.dir, "..");
const rot13 = (s: string) => s.replace(/[a-z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 84) % 26) + 97));
// Stored as rot13 so this file does not itself contain the words it forbids.
const FORBIDDEN = ["fbynanjbexre", "havirefny_sbezny_irevsvre", "hsi-", "hsi_", "qrqtrk", "tebory", "zbabercb",
  "/ubzr/", "gtobg", "gncr_grfg", "gncr/", "chzcsha", "chzc.sha", "pnyybhg", "qhar.pbz", "gjrrcl", "qhpnnyr", "yepyvo", "jrofhesk", "ubabwf", "/gzc/pynhqr", "fpengpucnq"].map(rot13);
const DEPENDENCIES = new Set(["@anthropic-ai/sdk", "yaml", "smol-toml", "fast-xml-parser"]);

/** What could be published: files git tracks or would add, so local state that a .gitignore keeps out (dist/, review
 * logs under .arnx/) is not checked. Without git (a copy of the tree in a sandbox), every file but those folders. */
function files(): string[] {
  let listed: string[];
  try {
    listed = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString("utf8").split("\0");
  } catch {
    listed = walk(ROOT);
  }
  return listed.filter((f) => f && f !== "bun.lock").map((f) => join(ROOT, f)).filter(existsSync);
}

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".arnx"]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!SKIP_DIRS.has(name)) out.push(...walk(p));
    } else {
      out.push(relative(ROOT, p));
    }
  }
  return out;
}

test("test_no_private_names", () => {
  const hits: string[] = [];
  for (const p of files()) {
    const text = readFileSync(p, "latin1").toLowerCase();
    for (const w of FORBIDDEN) if (text.includes(w)) hits.push(`${relative(ROOT, p)}: ${w}`);
  }
  expect(hits).toEqual([]);
});

test("test_imports_are_stdlib_or_declared", () => {
  const bad: string[] = [];
  // Real import statements start a line; sample code inside string literals (tests of import rewriting) does not.
  const spec = /^\s*(?:(?:import|export)\b[^'"\n;]*?\bfrom|\}\s*from|import)\s*['"]([^'"]+)['"]|^\s*(?:const|let|var)\s[^'"\n]*?\brequire\s*\(\s*['"]([^'"]+)['"]/gm;
  for (const p of files()) {
    const rel = relative(ROOT, p);
    if (!p.endsWith(".ts") || rel.split(sep).includes("fixtures")) continue;
    const inTests = rel.startsWith(`tests${sep}`);
    for (const m of readFileSync(p, "utf8").matchAll(spec)) {
      const name = (m[1] ?? m[2])!;
      const ok = name.startsWith("node:") || name.startsWith(".") || DEPENDENCIES.has(name) ||
        (inTests && name === "bun:test");
      if (!ok) bad.push(`${rel}: ${name}`);
    }
  }
  expect(bad).toEqual([]);
});

test("test_licence", () => {
  const licence = readFileSync(join(ROOT, "LICENSE"), "utf8");
  expect(licence.includes("Apache License") && licence.includes("Version 2.0, January 2004")).toBe(true);
  expect(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).license).toBe("Apache-2.0");
});
