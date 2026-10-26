// `arnx env prune`: environment images pile up (one per setup attempt and per dependency state, up to 17 GB each
// for Rust). A repository's images that no approved project uses now, older than the days kept, are removed; an
// image without arnx's labels (built before they existed) is counted, never removed.
import { loadReviewFile } from "./config";
import { LAYER_VERSION } from "./indexer";
import { docker, envKey, repoId } from "./sandbox";

export { repoId };

export interface EnvImage { tag: string; size: string; repo: string | null; project: string; created: string }
export interface Pruned { removed: EnvImage[]; failed: [EnvImage, string][]; unlabelled: number }

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
    // A current image's code indexer layer (indexer.ts) is current with it.
    current = loadReviewFile(repo).projects.flatMap((cfg) => [`arnx-env:${envKey(cfg, repo)}`,
      `arnx-env:${envKey(cfg, repo)}-${LAYER_VERSION}`]);
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
  return { removed, failed, unlabelled };
}

/** Docker's human sizes ("1.2GB", "300MB") summed, for a total. */
export function totalSize(images: EnvImage[]): string {
  const unit: Record<string, number> = { B: 1, kB: 1e3, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };
  const bytes = images.reduce((sum, i) => {
    const m = /^([\d.]+)\s*([kKMGT]?B)$/.exec(i.size);
    return sum + (m ? Number(m[1]) * (unit[m[2]!] ?? 0) : 0);
  }, 0);
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)}GB` : `${Math.round(bytes / 1e6)}MB`;
}
