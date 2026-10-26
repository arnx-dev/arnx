// Environment images carry labels saying whose they are; `arnx env prune` removes a repository's images that no
// approved project uses any more, and never an image without arnx's labels.
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseReviewConfig, parseReviewFile, reviewConfigPath, stampFile } from "../src/config";
import { pruneEnv, repoId } from "../src/envprune";
import { LAYER_VERSION } from "../src/indexer";
import { ensureEnv, envKey, envOwner, sandboxOptions } from "../src/sandbox";
import { Cli } from "./helpers/cli";
import { gitRepo } from "./helpers/gitutil";
import { useTmp } from "./helpers/tmp";
import { CFG } from "./helpers/yaml";

const tmp = useTmp();

/** A docker that lists `images` (one "tag\tid\tsize\tlabels" line each, labels as k=v,k=v), logs its arguments,
 * and fails `image rm` of a tag in `inUse`. */
function fakeDocker(images: string[], inUse: string[] = []): { calls: () => string[][] } {
  const dir = tmp();
  const log = join(dir, "calls");
  writeFileSync(join(dir, "images"), images.map((l) => {
    const [tag, , size, raw = ""] = l.split("\t");
    const labels = raw ? JSON.stringify(Object.fromEntries(raw.split(",").map((kv) => kv.split("=")))) : "null";
    return `${tag}\t${size}\t${labels}\n`;
  }).join(""));
  const busy = inUse.map((t) => `"${t}"`).join(" | ") || "__none__";
  writeFileSync(join(dir, "docker"), `#!/bin/sh
printf '%s\\037' "$@" >> '${log}'; echo >> '${log}'
case "$1 $2" in
  "image ls") cut -f1,2 '${join(dir, "images")}';;
  "image rm") case "$3" in ${busy}) echo "conflict: image is in use" >&2; exit 1;; esac;;
  "image inspect")
    [ "$3" = "--format" ] || exit 1
    shift 4
    for t in "$@"; do awk -F '\t' -v t="$t" '$1 == t { print $3 }' '${join(dir, "images")}'; done;;
esac
exit 0
`);
  chmodSync(join(dir, "docker"), 0o755);
  sandboxOptions.docker = join(dir, "docker");
  return { calls: () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean)
    .map((l) => l.split("\x1f").filter(Boolean)) };
}

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-19T12:00:00Z");
const labels = (repo: string, project: string, daysAgo: number, now = NOW) =>
  `arnx.config=abc,arnx.created=${new Date(now - daysAgo * DAY).toISOString()},arnx.project=${project},arnx.repo=${repo}`;

test("a build labels the image with its repository, project, config and time", async () => {
  const saved = sandboxOptions.docker;
  try {
    const docker = fakeDocker([]);
    const cfg = parseReviewConfig(CFG);
    envOwner.repo = "/work/app";
    await ensureEnv(cfg, tmp(), join(tmp(), "build.log"));
    const build = docker.calls().find((c) => c[0] === "build")!;
    const given = build.filter((_a, i) => build[i - 1] === "--label");
    const label = (k: string) => given.find((l) => l.startsWith(`${k}=`));
    expect(label("arnx.repo")).toBe(`arnx.repo=${repoId("/work/app")}`);
    expect(label("arnx.project")).toBe("arnx.project=main");
    expect(label("arnx.config")).toMatch(/^arnx\.config=[0-9a-f]{16}$/);
    expect(label("arnx.created")).toMatch(/^arnx\.created=\d{4}-\d\d-\d\dT/);
  } finally {
    sandboxOptions.docker = saved;
    envOwner.repo = null;
  }
});

test("prune removes this repository's images no approved project uses, past the age kept", () => {
  const saved = sandboxOptions.docker;
  try {
    const repo = gitRepo(tmp());
    mkdirSync(join(repo, "app"), { recursive: true });
    mkdirSync(join(repo, ".arnx"), { recursive: true });
    writeFileSync(reviewConfigPath(repo), stampFile(parseReviewFile(CFG), "u", "t"));
    const current = `arnx-env:${envKey(parseReviewConfig(CFG), repo)}`;
    const me = repoId(repo);
    const docker = fakeDocker([
      `${current}\tid1\t1.2GB\t${labels(me, "main", 30)}`,
      // the code indexer's layer on the current image (context = "precise") is current too
      `${current}-${LAYER_VERSION}\tid7\t0.7GB\t${labels(me, "main", 30)}`,
      `arnx-env:old1\tid2\t5GB\t${labels(me, "main", 30)}`,
      `arnx-env:recent\tid3\t5GB\t${labels(me, "main", 1)}`,
      `arnx-env:busy\tid4\t2GB\t${labels(me, "main", 30)}`,
      `arnx-env:theirs\tid5\t3GB\t${labels("0123456789abcdef", "web", 30)}`,
      "arnx-env:unlabelled\tid6\t4GB\t",
    ], ["arnx-env:busy"]);
    const r = pruneEnv(repo, { keepDays: 7, now: NOW });
    expect(r.removed.map((i) => i.tag)).toEqual(["arnx-env:old1"]);
    expect(r.failed.map(([i]) => i.tag)).toEqual(["arnx-env:busy"]);
    expect(r.unlabelled).toBe(1);
    expect(docker.calls().filter((c) => c[1] === "rm").map((c) => c[2]))
      .toEqual(["arnx-env:old1", "arnx-env:busy"]);
    // --keep-days 0 also takes the recent one; --all-repos also takes other repositories' old images; never unlabelled.
    expect(pruneEnv(repo, { keepDays: 0, now: NOW, dryRun: true }).removed.map((i) => i.tag))
      .toEqual(["arnx-env:old1", "arnx-env:recent", "arnx-env:busy"]);
    expect(pruneEnv(repo, { keepDays: 7, now: NOW, dryRun: true, allRepos: true }).removed.map((i) => i.tag))
      .toEqual(["arnx-env:old1", "arnx-env:busy", "arnx-env:theirs"]);
    // A dry run removes nothing.
    expect(docker.calls().filter((c) => c[1] === "rm")).toHaveLength(2);
  } finally {
    sandboxOptions.docker = saved;
  }
});

test("arnx env prune lists what it removes and what it cannot", async () => {
  const saved = sandboxOptions.docker;
  try {
    const repo = gitRepo(tmp());
    fakeDocker([`arnx-env:old1\tid2\t5GB\t${labels(repoId(repo), "main", 30.5, Date.now())}`, "arnx-env:x\tid6\t4GB\t"]);
    const cli = new Cli({ cwd: repo });
    expect(await cli.run("env", "prune", "--dry-run")).toBe(0);
    expect(cli.stdout).toContain("Would remove 1 image");
    expect(cli.stdout).toContain("arnx-env:old1 (main, 30 days old, 5GB)");
    expect(cli.stdout).toContain("1 older image has no arnx labels: arnx cannot tell whose it is, so it leaves it.");
    expect(cli.stdout).toMatch(/\nNothing removed \(dry run\)\.$/);
    expect(cli.stdout).not.toContain("docker image rm");
    expect(await cli.run("env", "prune", "--keep-days", "x")).toBe(2);
    expect(await cli.run("env", "list")).toBe(2);
  } finally {
    sandboxOptions.docker = saved;
  }
});
