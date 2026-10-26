// Environment images carry labels saying whose they are; `arnx env prune` removes a repository's images that no
// approved project uses any more, and never an image without arnx's labels.
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseReviewConfig, parseReviewFile, reviewConfigPath, stampFile } from "../src/config";
import { pruneEnv, repoId } from "../src/envprune";
import { ensureEnv, envKey, envOwner, sandboxOptions } from "../src/sandbox";
import { Cli } from "./helpers/cli";
import { gitRepo } from "./helpers/gitutil";
import { useTmp } from "./helpers/tmp";
import { CFG } from "./helpers/yaml";

const tmp = useTmp();

/** A docker that lists `images` (one "tag\tid\tsize\tlabels" line each, labels as k=v,k=v), logs its arguments,
 * fails `image rm` of a tag in `inUse`, and prints `cache` for `buildx du --verbose`. */
function fakeDocker(images: string[], inUse: string[] = [], cache = ""): { calls: () => string[][] } {
  const dir = tmp();
  const log = join(dir, "calls");
  writeFileSync(join(dir, "cache"), cache);
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
  "buildx du") cat '${join(dir, "cache")}';;
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

/** A build cache record as `docker buildx du --verbose` prints it. */
const record = (id: string, parents: string[], description: string, size = "0B", type = "regular") =>
  `ID:\t\t${id}\n${parents.length ? `Parents:\n${parents.map((p) => ` - ${p}\n`).join("")}` : ""}` +
  `Created at:\t2026-10-12 10:00:00.1 +0000 UTC\nMutable:\tfalse\nReclaimable:\ttrue\nShared:\t\tfalse\n` +
  `Size:\t\t${size}\nDescription:\t${description}\nUsage count:\t1\nLast used:\t2 weeks ago\nType:\t\t${type}\n`;

test("prune removes an old source image with the build cache records its build left, by id", () => {
  const saved = sandboxOptions.docker;
  try {
    const repo = gitRepo(tmp());
    const me = repoId(repo);
    const [a, b, c] = ["arnx-env:k1-src-aaaaaaaaaaaa", "arnx-env:k1-src-bbbbbbbbbbbb", "arnx-env:k1-src-cccccccccccc"];
    const cache = [
      record("base0", [], "pulled from docker.io/library/python:3.12-slim@sha256:00", "50MB"),
      // the environment image's own build
      record("envcopy", ["base0"], "[stage-0 2/4] COPY . /src", "10MB"),
      record("envrun", ["envcopy"], "mount / from exec /bin/sh -c pip install pytest", "1GB"),
      // a's build: its copy of the code, the marked step, the steps after it
      record("copya", ["base0"], "[stage-0 2/5] COPY . /src", "300MB"),
      record("marka", ["copya"], `mount / from exec /bin/sh -c : ${a}`),
      record("worka", ["marka"], "[stage-0 4/5] WORKDIR /src/app"),
      record("runa", ["worka"], "mount / from exec /bin/sh -c cp -r . /opt/app && pip install pytest", "2.35GB"),
      // b (another install of the same code) was built from the same copy: it stays while b does (named as some
      // BuildKit versions name the step)
      record("markb", ["copya"], `[stage-0 3/5] RUN : ${b}`),
      // c is in use, so neither it nor its records go
      record("copyc", ["base0"], "[stage-0 2/5] COPY . /src", "300MB"),
      record("markc", ["copyc"], `mount / from exec /bin/sh -c : ${c}`),
      record("mount", [], "cached mount /arnx-cache from exec /bin/sh -c pip install pytest", "800MB", "exec.cachemount"),
    ].join("\n");
    const docker = fakeDocker([
      `${a}\tid1\t2.4GB\t${labels(me, "main", 30)}`,
      `${b}\tid2\t2.4GB\t${labels(me, "main", 1)}`,
      `${c}\tid3\t2.4GB\t${labels(me, "main", 30)}`,
      `arnx-env:k1\tid4\t1GB\t${labels(me, "main", 30)}`,
    ], [c], cache);
    // A dry run lists what would go (c too: only removing it shows it is in use) and prunes nothing.
    const dry = pruneEnv(repo, { keepDays: 7, now: NOW, dryRun: true });
    expect(dry.cache.map((r) => r.id)).toEqual(["runa", "markc", "worka", "copyc", "marka"]);
    expect(docker.calls().filter((c) => c[0] === "buildx" && c[1] === "prune")).toEqual([]);
    const r = pruneEnv(repo, { keepDays: 7, now: NOW });
    expect(r.removed.map((i) => i.tag)).toEqual([a, "arnx-env:k1"]);
    // Leaves first, one exact id per call, never a prune of everything; copya stays (b builds on it), and the
    // environment image's build cache and the download cache are not touched.
    expect(r.cache.map((x) => x.id)).toEqual(["runa", "worka", "marka"]);
    expect(docker.calls().filter((c) => c[0] === "buildx" && c[1] === "prune"))
      .toEqual(["runa", "worka", "marka"].map((id) => ["buildx", "prune", "-f", "--filter", `id=${id}`]));
    // With b gone too, the copy they share goes.
    expect(pruneEnv(repo, { keepDays: 0, now: NOW, dryRun: true }).cache.map((x) => x.id).sort())
      .toEqual(["copya", "copyc", "marka", "markb", "markc", "runa", "worka"]);
  } finally {
    sandboxOptions.docker = saved;
  }
});

test("arnx env prune names the build cache it removes with the images made from the code", async () => {
  const saved = sandboxOptions.docker;
  try {
    const repo = gitRepo(tmp());
    const tag = "arnx-env:k1-src-aaaaaaaaaaaa";
    fakeDocker([`${tag}\tid1\t2.4GB\t${labels(repoId(repo), "main", 30.5, Date.now())}`], [],
      [record("copya", ["base0"], "[stage-0 2/5] COPY . /src", "300MB"),
        record("marka", ["copya"], `mount / from exec /bin/sh -c : ${tag}`),
        record("runa", ["marka"], "mount / from exec /bin/sh -c cp -r . /opt/app && pip install pytest", "2.35GB")].join("\n"));
    const cli = new Cli({ cwd: repo });
    expect(await cli.run("env", "prune")).toBe(0);
    expect(cli.stdout).toContain(`Removed 1 image (2.4GB):\n  ${tag} (main, 30 days old, 2.4GB)\n` +
      "Removed their build cache: 3 records (2.6GB).\n");
  } finally {
    sandboxOptions.docker = saved;
  }
});
