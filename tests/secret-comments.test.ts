// A key-shaped string inside a source file's comment (a doc example) blanks that comment line, not the whole file;
// one in code still withholds the file. Keys here are built from parts, so this file holds none.
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describeBlanked, resolveChange, takeSnapshot } from "../src/change";
import { render } from "../src/report";
import type { SessionFactory } from "../src/sandbox";
import { hasSecretContent, scanKeys, secretPins } from "../src/secrets";
import { defaultSettings } from "../src/settings";
import { runSetup } from "../src/setup";
import { fakeFactory, ScriptedAgent, text, tool } from "./helpers/fakes";
import { commit, gitRepo } from "./helpers/gitutil";
import { sampleReview } from "./helpers/review";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const PEM = "-----BEGIN " + "PRIVATE KEY-----";
const PEM_END = "-----END " + "PRIVATE KEY-----";
const BODY = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7";
const GH = "ghp_" + "a".repeat(36);
const SK = "sk-" + "A".repeat(40);

/** The blanked text, checked to hold no key and to keep the line count. */
function blanked(path: string, text: string): { lines: number[]; text: string } {
  const r = scanKeys(path, text, []);
  if (!r || !("blank" in r)) throw new Error(`not blanked: ${JSON.stringify(r)}`);
  expect(hasSecretContent(r.text)).toBe(false);
  expect(r.text).not.toContain(BODY);
  expect(r.text.split("\n").length).toBe(text.split("\n").length);
  return { lines: r.blank, text: r.text };
}
const withheld = (path: string, text: string) => {
  const r = scanKeys(path, text, []);
  return r && "withhold" in r ? r.withhold : null;
};

test("JS and TS: a JSDoc example and a trailing // comment are blanked, code and delimiters stay", () => {
  const doc = ["/**", " * A service account credential.", " * @example", ` * privateKey: "${PEM}..."`, " */",
    "export interface Credential { privateKey: string }", ""].join("\n");
  for (const path of ["src/auth.ts", "src/auth.tsx", "lib/auth.js", "lib/auth.mjs", "lib/auth.cjs"]) {
    expect(blanked(path, doc)).toEqual({ lines: [4], text: doc.replace(` * privateKey: "${PEM}..."`, "") });
  }
  // The comment closes on the next line with code after it: only the comment's part of each line goes.
  const trailing = `const n = 1; // e.g. ${GH}\nconst url = "http://example.com"; /* ${SK} */ run();\n`;
  expect(blanked("a.ts", trailing).text).toBe('const n = 1; //\nconst url = "http://example.com"; /**/ run();\n');
  // An opening line keeps its /*, so the comment still closes where it did.
  expect(blanked("a.ts", `/** token ${GH}\n * more\n */\nx();\n`).text).toBe("/*\n * more\n */\nx();\n");
});

test("JS and TS: a key in a string, a template literal or after a regex literal is in code: the file is withheld", () => {
  expect(withheld("a.ts", `const k = "${SK}";\n`)).toEqual({ line: 1, label: "sk-…" });
  expect(withheld("a.ts", `const u = "http://x"; const k = '${SK}';\n`)).toEqual({ line: 1, label: "sk-…" });
  expect(withheld("a.ts", `const t = \`// \${a + "}"} ${GH}\`;\n`)).toEqual({ line: 1, label: "ghp_…" });
  expect(withheld("a.js", `const re = /\\/\\//; const k = "${GH}";\n`)).toEqual({ line: 1, label: "ghp_…" });
  // One in code withholds the file even when others are in comments.
  expect(withheld("a.ts", `// ${GH}\nconst k = "${SK}";\n`)).toEqual({ line: 2, label: "sk-…" });
});

test("Python: a # comment is blanked; a key in a string or a docstring withholds the file", () => {
  const src = `def connect():\n    # example: token = "${GH}"\n    return None  # or ${SK}\n`;
  expect(blanked("app/client.py", src).text).toBe("def connect():\n    #\n    return None  #\n");
  expect(blanked("app/client.pyi", src).lines).toEqual([2, 3]);
  expect(withheld("app/client.py", `URL = "http://x#frag"; K = "${GH}"\n`)).toEqual({ line: 1, label: "ghp_…" });
  expect(withheld("app/client.py", `def f():\n    """Example:\n\n    key = ${GH}\n    """\n`))
    .toEqual({ line: 4, label: "ghp_…" });
});

test("Rust: line, doc and nested block comments are blanked; raw strings and char literals are code", () => {
  expect(blanked("src/lib.rs", `//! Crate docs: ${GH}\n/// Example: ${SK}\nfn f() {}\n`).text)
    .toBe("//\n//\nfn f() {}\n");
  // Nesting survives: the inner /* and */ stay.
  expect(blanked("src/lib.rs", `/* outer\n   /* inner ${GH}\n   */\n*/\nfn f() {}\n`).text)
    .toBe("/* outer\n/*\n   */\n*/\nfn f() {}\n");
  expect(blanked("src/lib.rs", `let q = '"'; // ${GH}\nfn g<'a>(x: &'a str) {} // ${SK}\n`).text)
    .toBe("let q = '\"'; //\nfn g<'a>(x: &'a str) {} //\n");
  expect(withheld("src/lib.rs", `let k = r#"// "${GH}"#;\n`)).toEqual({ line: 1, label: "ghp_…" });
  expect(withheld("src/lib.rs", `let k = "multi\n// ${GH}";\n`)).toEqual({ line: 2, label: "ghp_…" });
});

test("a private key in a comment is blanked with its body; a body outside the comment withholds the file", () => {
  const block = `/*\n * ${PEM}\n * ${BODY}\n * ${BODY}\n * ${PEM_END}\n * Keep this.\n */\n`;
  expect(blanked("a.ts", block)).toEqual({ lines: [2, 3, 4, 5], text: "/*\n\n\n\n\n * Keep this.\n */\n" });
  const hashes = `# ${PEM}\n# ${BODY}\n# ${PEM_END}\nx = 1\n`;
  expect(blanked("a.py", hashes)).toEqual({ lines: [1, 2, 3], text: "#\n#\n#\nx = 1\n" });
  expect(withheld("a.py", `# ${PEM}\nBODY = """\n${BODY}\n"""\n`)).toEqual({ line: 3, label: "a private key" });
  expect(withheld("a.py", `# ${PEM}\n${BODY}\n`)).toEqual({ line: 2, label: "a private key" });
});

test("other files are withheld as before, and pinned keys are left alone", () => {
  expect(withheld("README.md", `<!-- ${GH} -->\n`)).toEqual({ line: 1, label: "ghp_…" });
  expect(withheld("config.yaml", `# ${GH}\n`)).toEqual({ line: 1, label: "ghp_…" });
  const text = `// ${GH}\n`;
  expect(scanKeys("a.ts", text, secretPins(text))).toBeNull();
});

test("the snapshot keeps a file whose key is in a comment, with the line blanked, and says so", () => {
  const repo = gitRepo(tmp());
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src/auth.ts"), `/**\n * privateKey: "${PEM}..."\n */\nexport const A = 1;\n`);
  writeFileSync(join(repo, "src/keys.ts"), `export const K = "${SK}";\n`);
  commit(repo, "keys");
  const snap = join(tmp(), "snap");
  const { withheld: gone, blanked: lines } = takeSnapshot(repo, null, snap);
  expect(gone.map((w) => w.path)).toEqual(["src/keys.ts"]);
  expect(lines).toEqual([{ path: "src/auth.ts", lines: [2] }]);
  expect(readFileSync(join(snap, "src/auth.ts"), "utf8")).toBe("/**\n\n */\nexport const A = 1;\n");
});

test("setup keeps a blanked file in its snapshot and names it with its lines", async () => {
  const repo = gitRepo(tmp());
  writeFileSync(join(repo, "creds.py"), `# Example:\n# ${PEM}\n# ${BODY}\n# ${PEM_END}\nNAME = "creds"\n`);
  commit(repo, "creds");
  const yaml = "version: 1\nimage: python:3.12-slim\ntest_command: python -m pytest -q {targets}\n";
  const seen: string[] = [];
  const inner = fakeFactory(() => [junitXml([["tests/test_a.py", "test_a", "passed", ""]]), "1 passed", false]);
  const sessions: SessionFactory = (cfg, snap, log, body) => {
    seen.push(readFileSync(join(snap, "creds.py"), "utf8"));
    return inner(cfg, snap, log, body);
  };
  const progress: string[] = [];
  const r = await runSetup(repo, defaultSettings(), new ScriptedAgent([[tool("propose", { yaml })], [text("done")]]),
    { outDir: join(tmp(), "setup"), sessionFactory: sessions, progress: (m) => progress.push(m) });
  expect([r.ok, r.withheld, r.blanked]).toEqual([true, [], [{ path: "creds.py", lines: [2, 3, 4] }]]);
  expect(seen).toEqual(['# Example:\n#\n#\n#\nNAME = "creds"\n']);
  expect(progress).toContain("comment lines blanked as secret-looking: creds.py (lines 2-4)");
  expect(describeBlanked([{ path: "a.ts", lines: [3, 4, 5, 9] }, { path: "b.rs", lines: [7] }]))
    .toBe("a.ts (lines 3-5, 9), b.rs (line 7)");
});

test("a review's diff: a key in a comment on an added line is blanked and the review goes on", () => {
  const repo = gitRepo(tmp());
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src/auth.ts"), "/**\n * A credential.\n */\nexport interface Credential { key: string }\n");
  commit(repo, "auth");
  writeFileSync(join(repo, "src/auth.ts"),
    `/**\n * A credential.\n * @example\n * key: "${PEM}..."\n */\nexport interface Credential { key: string }\n`);
  const c = resolveChange(repo);
  expect(hasSecretContent(c.diff)).toBe(false);
  expect(c.diff).toContain("\n+ * @example\n+\n  */\n");
  expect(c.blanked).toEqual([{ path: "src/auth.ts", lines: [4] }]);
  // Committed, the same holds for the commit's diff.
  commit(repo, "example");
  const done = resolveChange(repo);
  expect([hasSecretContent(done.diff), done.blanked]).toEqual([false, [{ path: "src/auth.ts", lines: [4] }]]);
});

test("a review's diff: a key in a comment on a context or removed line is blanked; one in code still refuses", () => {
  const repo = gitRepo(tmp());
  writeFileSync(join(repo, "client.py"), `# token = "${GH}"\nA = 1\n`);
  writeFileSync(join(repo, "lib.rs"), `/// Example: ${SK}\nfn f() {}\n`);
  commit(repo, "keys in comments");
  writeFileSync(join(repo, "client.py"), `# token = "${GH}"\nA = 2\n`);
  writeFileSync(join(repo, "lib.rs"), "fn f() {}\n");
  const c = resolveChange(repo);
  expect(hasSecretContent(c.diff)).toBe(false);
  expect(c.diff).toContain("@@\n #\n-A = 1\n+A = 2\n");
  expect(c.diff).toContain("@@\n-//\n fn f() {}\n");
  expect(c.blanked).toEqual([{ path: "client.py", lines: [1] }, { path: "lib.rs", lines: [1] }]);
  writeFileSync(join(repo, "client.py"), `# token = "${GH}"\nA = "${GH}"\n`);
  expect(() => resolveChange(repo)).toThrow("the change contains text that looks like a secret (a key or token) in " +
    "client.py (ghp_…)");
});

test("the review names the files whose comment lines were blanked", () => {
  const md = render(sampleReview({ blankedLines: [{ path: "src/auth.ts", lines: [4] }] }));
  expect(md).toContain("- Comment lines blanked as secret-looking (not sent): src/auth.ts (line 4)");
  expect(render(sampleReview())).not.toContain("Comment lines blanked");
});
