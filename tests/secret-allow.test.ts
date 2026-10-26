// Files the user allowed although they hold key-shaped text: review.yaml allow_secret_looking, pinned per string,
// covered by the approval, and written by `arnx allow-secret`.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  fileDigest, isFileApproved, isSeedFile, loadReviewFile, parseReviewFile, projectDigest, readSecretPins, reviewConfigPath,
  secretPinsOf, stampFile, withSecretPins,
} from "../src/config";
import { ArnxError, SetupRequired } from "../src/errors";
import type { SessionFactory } from "../src/sandbox";
import { secretPins } from "../src/secrets";
import { defaultSettings } from "../src/settings";
import { approveFile, runSetup } from "../src/setup";
import { fakeFactory, ScriptedAgent, text, tool } from "./helpers/fakes";
import { Cli } from "./helpers/cli";
import { gitRepo, runGit } from "./helpers/gitutil";
import { sampleReview } from "./helpers/review";
import { render } from "../src/report";
import { worthALook } from "../src/setupview";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";
import { GOOD, PROJECTS } from "./helpers/yaml";
import { AWS_KEY } from "./helpers/fakekeys";

const tmp = useTmp();
const FIXTURE = `AWS = '${AWS_KEY}'\n`;
const PIN = { path: "crates/common/src/secrets.rs", matches: secretPins(FIXTURE) };

test("allow_secret_looking parses in both kinds of file, and its pins are what snapshots keep", () => {
  for (const base of [GOOD, PROJECTS]) {
    const f = parseReviewFile(withSecretPins(base, [PIN]));
    expect(secretPinsOf(f.raw)).toEqual([PIN]);
    expect(secretPinsOf(f.projects[0]!.raw)).toEqual([PIN]);
  }
  expect(secretPinsOf(parseReviewFile(GOOD).raw)).toEqual([]);
});

test.each([
  ["not a list", "allow_secret_looking: {a: b}\n"],
  ["no matches", "allow_secret_looking:\n  - path: a.rs\n"],
  ["a match that is not a pin", `allow_secret_looking:\n  - {path: a.rs, matches: [${AWS_KEY}]}\n`],
  ["outside the repository", `allow_secret_looking:\n  - {path: ../a.rs, matches: [${PIN.matches[0]}]}\n`],
])("allow_secret_looking refuses %s", (_name, extra) => {
  expect(() => parseReviewFile(GOOD + extra)).toThrow(/allow_secret_looking/);
});

test("the approval covers the allow-list: adding a file needs approving again, in every project", () => {
  const stamped = stampFile(parseReviewFile(PROJECTS), "u", "t");
  expect(isFileApproved(parseReviewFile(stamped))).toBe(true);
  const allowed = parseReviewFile(withSecretPins(stamped, [PIN]));
  expect(isFileApproved(allowed)).toBe(false);
  for (const p of allowed.projects) {
    expect(projectDigest(allowed, p.name)).not.toBe(projectDigest(parseReviewFile(PROJECTS), p.name));
  }
  // Files without the key keep their digests (approvals made before it existed stay valid).
  expect(fileDigest(parseReviewFile(PROJECTS))).toBe(fileDigest(parseReviewFile(withSecretPins(PROJECTS, []))));
});

test("allow-secret writes a seed before setup, and replaces a path's pins after", () => {
  const repo = tmp();
  mkdirSync(join(repo, ".arnx"));
  expect(readSecretPins(repo)).toEqual([]);
  writeFileSync(reviewConfigPath(repo), withSecretPins(null, [PIN]));
  expect(readSecretPins(repo)).toEqual([PIN]);
  // A seed is not a test environment yet: setup may write over it.
  expect(isSeedFile(repo)).toBe(true);
  expect(() => loadReviewFile(repo, { requireApproved: false })).toThrow(SetupRequired);
  expect(() => loadReviewFile(repo, { requireApproved: false })).toThrow(/arnx setup/);
  const again = { path: PIN.path, matches: secretPins(FIXTURE + "T = 'ghp_" + "c".repeat(36) + "'\n") };
  const other = { path: "a.py", matches: PIN.matches };
  const text = withSecretPins(withSecretPins(GOOD, [PIN, other]), [again]);
  expect(secretPinsOf(parseReviewFile(text).raw)).toEqual([other, again]);
});

test("a pin made only of digits reads back as a string", () => {
  const digits = { path: "a.py", matches: ["1234567890123456"] };
  expect(secretPinsOf(parseReviewFile(withSecretPins(GOOD, [digits])).raw)).toEqual([digits]);
});

test("a broken allow-list in an unparseable file still stops setup", () => {
  const repo = tmp();
  mkdirSync(join(repo, ".arnx"));
  writeFileSync(reviewConfigPath(repo), "allow_secret_looking: [x]\n");
  expect(() => readSecretPins(repo)).toThrow(ArnxError);
});

const YAML = `version: 1
image: python:3.12-slim
install: [pip install pytest]
test_command: python -m pytest -q {targets}
`;
const passing = (): [string | null, string, boolean] =>
  [junitXml([["tests/test_a.py", "test_a", "passed", ""]]), "1 passed", false];

/** A fake sandbox that records whether the snapshot it ran on held `rel`. */
function seeing(rel: string, held: boolean[]): SessionFactory {
  const inner = fakeFactory(passing);
  return (cfg, snap, log, body) => {
    held.push(existsSync(join(snap, rel)));
    return inner(cfg, snap, log, body);
  };
}

const firstUser = (m: ScriptedAgent) => JSON.stringify(m.calls[0]!.messages[0]!.content);

test("setup reports the files it withheld, to the agent and in its result", async () => {
  const repo = gitRepo(tmp());
  writeFileSync(join(repo, "detect.py"), FIXTURE);
  runGit(repo, "add", "detect.py");
  const model = new ScriptedAgent([[tool("propose", { yaml: YAML })], [text("done")]]);
  const held: boolean[] = [];
  const r = await runSetup(repo, defaultSettings(), model, { outDir: join(tmp(), "setup"),
    sessionFactory: seeing("detect.py", held) });
  expect(r.withheld).toEqual([{ path: "detect.py", line: 1, label: "AKIA…" }]);
  expect(held).toEqual([false]);
  expect(firstUser(model)).toContain("detect.py (AKIA…, line 1)");
  expect(r.yamlText).toBe(YAML);
});

test("setup keeps the files a seed allows and carries the allow-list into its proposal", async () => {
  const repo = gitRepo(tmp());
  writeFileSync(join(repo, "detect.py"), FIXTURE);
  runGit(repo, "add", "detect.py");
  const pin = { path: "detect.py", matches: secretPins(FIXTURE) };
  mkdirSync(join(repo, ".arnx"), { recursive: true });
  writeFileSync(reviewConfigPath(repo), withSecretPins(null, [pin]));
  const model = new ScriptedAgent([
    [tool("propose", { yaml: YAML + "allow_secret_looking: []\n" })],
    [tool("propose", { yaml: YAML })],
    [text("done")]]);
  const held: boolean[] = [];
  const r = await runSetup(repo, defaultSettings(), model, { outDir: join(tmp(), "setup"),
    sessionFactory: seeing("detect.py", held) });
  expect(String((model.calls[1]!.messages.at(-1)!.content as Record<string, unknown>[])[0]!.content))
    .toContain("only the user allows");
  expect([r.ok, r.withheld, held]).toEqual([true, [], [true]]);
  expect(secretPinsOf(parseReviewFile(r.yamlText!).raw)).toEqual([pin]);
  // approve runs on the same snapshot, the allowed file included.
  writeFileSync(reviewConfigPath(repo), r.yamlText!);
  const approved: boolean[] = [];
  const [ok] = await approveFile(repo, { by: "u", at: "t", sessionFactory: seeing("detect.py", approved) });
  expect([ok, approved]).toEqual([true, [true]]);
  expect(secretPinsOf(parseReviewFile(readFileSync(reviewConfigPath(repo), "utf8")).raw)).toEqual([pin]);
});

test("arnx allow-secret pins a file's key-shaped strings into review.yaml and sends to setup or review", async () => {
  const repo = gitRepo(tmp());
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "detect.py"), "A = 1\n" + FIXTURE);
  writeFileSync(join(repo, "plain.py"), "A = 1\n");
  const cli = new Cli({ cwd: join(repo, "src") });
  expect(await cli.run("allow-secret", "detect.py")).toBe(0);
  expect(readSecretPins(repo)).toEqual([{ path: "src/detect.py", matches: secretPins(FIXTURE) }]);
  expect(cli.stdout).toContain("src/detect.py: 1 key-like string (AKIA… line 2)");
  expect(cli.stdout).toContain("arnx setup");
  expect(cli.stdout).not.toContain(AWS_KEY);
  // After setup the file is a full review.yaml: allowing more needs a new proof, which the next review runs.
  writeFileSync(reviewConfigPath(repo), withSecretPins(stampFile(parseReviewFile(YAML), "u", "t"), readSecretPins(repo)));
  writeFileSync(join(repo, "src", "detect.py"), FIXTURE + "T = 'ghp_" + "d".repeat(36) + "'\n");
  expect(await cli.run("allow-secret", "detect.py")).toBe(0);
  expect(readSecretPins(repo)[0]!.matches).toHaveLength(2);
  expect(cli.out.at(-1)).toBe("Next: arnx review");
  expect(isFileApproved(parseReviewFile(readFileSync(reviewConfigPath(repo), "utf8")))).toBe(false);
  for (const bad of ["../plain.py", "missing.py", "/etc/hostname"]) expect(await cli.run("allow-secret", bad)).toBe(2);
  expect(cli.stderr).toContain("nothing that looks like a key");
  writeFileSync(join(repo, ".env"), FIXTURE);
  expect(await cli.run("allow-secret", "../.env")).toBe(2);
  expect(cli.stderr).toContain("never sent");
});

test("worth a look names the allowed files", () => {
  const repo = gitRepo(tmp());
  const pin = { path: "detect.py", matches: secretPins(FIXTURE) };
  const f = parseReviewFile(withSecretPins(YAML, [pin]));
  expect(worthALook(f, repo, {}).join("\n")).toContain("detect.py");
  expect(worthALook(f, repo, {}).join("\n")).toContain("allowed although secret-looking");
  expect(worthALook(parseReviewFile(YAML), repo, {}).join("\n")).not.toContain("secret-looking");
});

test("the review names withheld files and how to allow one", () => {
  const md = render(sampleReview({ notSent: ["src/detect.py"] }));
  expect(md).toContain("`src/detect.py`");
  expect(md).toContain("arnx allow-secret");
});
