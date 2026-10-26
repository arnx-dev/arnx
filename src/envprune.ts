// `arnx env prune`: environment images pile up (one per setup attempt and per dependency state, up to 17 GB each
// for Rust; one per version of the code for a project whose install copies its code, baked.ts). A repository's images
// that no approved project uses now, older than the days kept, are removed; an image without arnx's labels (built
// before they existed) is counted, never removed. An image made from the code under test also takes the build cache
// records its build left (the layers stay on disk with them): each by its id, found from the step marked with the
// image's tag (sandbox.ts dockerfile), never a prune of the whole cache.
import { loadReviewFile } from "./config";
import { docker, envKey, repoId } from "./sandbox";

export { repoId };

export interface EnvImage { tag: string; size: string; repo: string | null; project: string; created: string }
/** `cache`: the build cache records removed (with dryRun, to remove) with the images made from the code. */
export interface Pruned {
  removed: EnvImage[]; failed: [EnvImage, string][]; unlabelled: number; cache: CacheRecord[];
}

/** A BuildKit build cache record, as `docker buildx du --verbose` prints it. */
export interface CacheRecord { id: string; parents: string[]; description: string; size: string; type: string }

const DAY_MS = 86_400_000;

/** Every `arnx-env` image, with its labels (`image ls` cannot print labels: one `image inspect` reads them all). */
function envImages(): { labelled: EnvImage[]; unlabelled: number } {
  const listed = docker(["image", "ls", "--filter", "reference=arnx-env", "--format", "{{.Repository}}:{{.Tag}}\t{{.Size}}"])
    .stdout.split("\n").filter((l) => l.trim()).map((l) => l.split("\t") as [string, string]);
  if (!listed.length) return { labelled: [], unlabelled: 0 };
  const inspected = docker(["image", "inspect", "--format", "{{json .Config.Labels}}", ...listed.map(([t]) => t)])
    .stdout.split("\n").filter((l) => l.trim());
  const labelled: EnvImage[] = [];
  let unlabelled = 0;
  for (const [i, [tag, size]] of listed.entries()) {
    let labels: Record<string, string> = {};
    try {
      labels = JSON.parse(inspected[i] ?? "null") ?? {};
    } catch {
      labels = {};
    }
    if (!labels["arnx.created"]) unlabelled++;
    else labelled.push({ tag, size, repo: labels["arnx.repo"] ?? null, project: labels["arnx.project"] ?? "",
      created: labels["arnx.created"] });
  }
  return { labelled, unlabelled };
}

/** Every environment image arnx built for this repository, whatever its age or use. */
export const repoImages = (repo: string): EnvImage[] => envImages().labelled.filter((i) => i.repo === repoId(repo));

export const ageDays = (img: EnvImage, now: number) => (now - Date.parse(img.created)) / DAY_MS;

/** Removes (or with dryRun lists) this repository's images that are not an approved project's current environment
 * and are at least `keepDays` old; `allRepos` also takes other repositories' images that old. */
export function pruneEnv(repo: string, o: { keepDays: number; now?: number; dryRun?: boolean; allRepos?: boolean })
  : Pruned {
  const now = o.now ?? Date.now();
  let current: string[] = [];
  try {
    current = loadReviewFile(repo).projects.map((cfg) => `arnx-env:${envKey(cfg, repo)}`);
  } catch {
    current = []; // no approved file: no image is current
  }
  const me = repoId(repo);
  const { labelled, unlabelled } = envImages();
  const removed: EnvImage[] = [], failed: [EnvImage, string][] = [];
  for (const img of labelled) {
    const mine = img.repo === me;
    if (!(mine || o.allRepos) || (mine && current.includes(img.tag)) || ageDays(img, now) < o.keepDays) continue;
    if (o.dryRun) {
      removed.push(img);
      continue;
    }
    const r = docker(["image", "rm", img.tag]);
    if (r.status === 0) removed.push(img);
    else failed.push([img, (r.stderr || r.stdout).trim().split("\n")[0] ?? ""]);
  }
  const sources = removed.map((i) => i.tag).filter((t) => t.includes("-src-"));
  let cache = sources.length ? sourceRecords(cacheRecords(), sources) : [];
  if (!o.dryRun) {
    cache = cache.filter((c) =>
      docker(["buildx", "prune", "-f", "--filter", `id=${c.id}`], { timeout: 300 }).status === 0);
  }
  return { removed, failed, unlabelled, cache };
}

/** Every build cache record; none when Docker has no BuildKit (an image delete then frees its layers). */
export function cacheRecords(): CacheRecord[] {
  let out: string;
  try {
    const r = docker(["buildx", "du", "--verbose"], { timeout: 120 });
    if (r.status !== 0) return [];
    out = r.stdout;
  } catch {
    return [];
  }
  const records: CacheRecord[] = [];
  for (const block of out.split(/\n\s*\n/)) {
    const field = (name: string) => new RegExp(`^${name}:[ \\t]*(.*)$`, "m").exec(block)?.[1]?.trim() ?? "";
    const id = field("ID");
    if (!/^[a-z0-9]+$/.test(id)) continue;
    // "Parents:" with one " - id" line each; older buildx prints "Parent: id".
    const parents = [...block.matchAll(/^ - ([a-z0-9]+)$/gm)].map((m) => m[1]!);
    if (field("Parent")) parents.push(field("Parent"));
    records.push({ id, parents, description: field("Description"), size: field("Size"), type: field("Type") });
  }
  return records;
}

/** The records the builds of `tags` (images made from the code) left, leaves first: each build's marked step, every
 * step built on it, and the copy of the code below it when nothing else builds on that copy. */
export function sourceRecords(records: CacheRecord[], tags: string[]): CacheRecord[] {
  const regular = records.filter((r) => r.type === "regular" || r.type === "");
  const marks = new Set(tags.map((t) => `RUN : ${t}`));
  const set = new Set(regular.filter((r) => [...marks].some((m) => r.description.endsWith(m))).map((r) => r.id));
  if (!set.size) return [];
  const marked = [...set];
  for (let grew = true; grew;) {
    grew = false;
    for (const r of regular) {
      if (set.has(r.id) || !r.parents.some((p) => set.has(p))) continue;
      set.add(r.id);
      grew = true;
    }
  }
  const children = (id: string) => records.filter((r) => r.parents.includes(id));
  for (const id of marked) {
    for (const p of regular.find((r) => r.id === id)!.parents) {
      const copy = regular.find((r) => r.id === p && /\bCOPY \. \/src$/.test(r.description));
      if (copy && children(p).every((c) => set.has(c.id))) set.add(p);
    }
  }
  // Leaves first: a record still built on is not removed.
  const out: CacheRecord[] = [];
  const left = regular.filter((r) => set.has(r.id));
  while (left.length) {
    const wave = left.filter((r) => !left.some((x) => x.parents.includes(r.id)));
    if (!wave.length) break;
    out.push(...wave);
    for (const r of wave) left.splice(left.indexOf(r), 1);
  }
  return out;
}

/** Docker's human sizes ("1.2GB", "300MB") summed, for a total. */
export function totalSize(images: { size: string }[]): string {
  const unit: Record<string, number> = { B: 1, kB: 1e3, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };
  const bytes = images.reduce((sum, i) => {
    const m = /^([\d.]+)\s*([kKMGT]?B)$/.exec(i.size);
    return sum + (m ? Number(m[1]) * (unit[m[2]!] ?? 0) : 0);
  }, 0);
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)}GB` : `${Math.round(bytes / 1e6)}MB`;
}
