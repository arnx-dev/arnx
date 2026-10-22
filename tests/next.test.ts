// arnx next: the flow's state read from the repository, and the one command to run now.
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseReviewFile, reviewConfigPath, stampFile } from "../src/config";
import { whatNext } from "../src/next";
import { save } from "../src/report";
import { writeSettings, defaultSettings } from "../src/settings";
import { commit, gitRepo, runGit } from "./helpers/gitutil";
import { sampleReview } from "./helpers/review";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const YAML = "version: 1\nprojects:\n  svc:\n    root: svc\n    image: python:3.12-slim\n    test_command: pytest {targets}\n";

test("next walks the flow: init, setup, approve, review, triage, check", () => {
  const repo = gitRepo(tmp());
  mkdirSync(join(repo, "svc"));
  writeFileSync(join(repo, "svc/a.py"), "X = 1\n");
  commit(repo, "a");
  expect(whatNext(repo)).toMatchObject({ command: "arnx init", phase: "1. Prepare" });
  writeSettings(repo, { ...defaultSettings(), consentAt: "2026-10-14T00:00:00Z" });
  expect(whatNext(repo).command).toBe("arnx setup");
  writeFileSync(reviewConfigPath(repo), YAML);
  expect(whatNext(repo).command).toBe("arnx approve");
  writeFileSync(reviewConfigPath(repo), stampFile(parseReviewFile(YAML), "Dev", "2026-10-14"));
  writeFileSync(join(repo, "svc/a.py"), "X = 2\n");
  expect(whatNext(repo)).toMatchObject({ command: "arnx review" });
  const rdir = join(repo, ".arnx/reviews/20261014-abcdef");
  mkdirSync(rdir, { recursive: true });
  writeFileSync(join(rdir, "state.json"), "{}\n");
  expect(whatNext(repo).command).toBe("arnx review --resume");
  save({ ...sampleReview(), id: "20261014-abcdef" }, rdir, "d");
  expect(whatNext(repo)).toMatchObject({ command: "arnx triage 20261014-abcdef", phase: "3. Decide" });
  writeFileSync(join(rdir, "accepted.json"), "{}\n");
  expect(whatNext(repo)).toMatchObject({ command: "fix the bugs", then: "arnx check", phase: "4. Fix",
    where: "review 20261014-abcdef accepted; fixes not verified yet" });
});

/** A repository set up and approved, with no review yet. */
function approved(): string {
  const repo = gitRepo(tmp());
  mkdirSync(join(repo, "svc"));
  writeFileSync(join(repo, "svc/a.py"), "X = 1\n");
  commit(repo, "a");
  writeSettings(repo, { ...defaultSettings(), consentAt: "2026-10-14T00:00:00Z" });
  writeFileSync(reviewConfigPath(repo), stampFile(parseReviewFile(YAML), "Dev", "2026-10-14"));
  return repo;
}

test("a change over the size limit is next's answer, not 'nothing to review'", () => {
  const repo = approved();
  writeFileSync(join(repo, "svc/big.py"), "X = 1\n".repeat(50_000));
  runGit(repo, "add", "svc/big.py");
  const n = whatNext(repo);
  expect(n.where).toContain("arnx reviews up to 200 KB");
  expect(n.command).toBe("arnx review --range A..B");
  expect(n.phase).toBe("2. Review");
});

test("a change that cannot be sent is shown as the error itself", () => {
  const repo = approved();
  writeFileSync(join(repo, "svc/key.py"), `KEY = "sk-ant-api03-${"a".repeat(90)}"\n`);
  runGit(repo, "add", "svc/key.py");
  const n = whatNext(repo);
  expect(n.where).toBe("the change cannot be reviewed");
  expect(n.command).toContain("looks like a secret");
  expect(n.phase).toBe("2. Review");
});

test("only an empty change is 'nothing to review'", () => {
  const repo = approved();
  runGit(repo, "commit", "-q", "--allow-empty", "-m", "empty");
  expect(whatNext(repo)).toMatchObject({ where: "no changes to review", command: "arnx review --range BASE..HEAD" });
});
