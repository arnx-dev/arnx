// The project's code index (SCIP) at a snapshot, for the hunter's context when `[review] context = "precise"`. The
// indexer runs in the project's environment image plus a layer that holds it, the way tests run: no network, the
// same limits, user and /src mount, and it writes only to a folder of its own. Anything that goes wrong leaves the
// hunt on names, with the reason in the events.
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, posix } from "node:path";
import { adapterFor, type AdapterId } from "./adapters";
import type { ReviewConfig } from "./config";
import { emit } from "./events";
import { readIndex, type ScipIndex } from "./scip";
import { BUILD_TIMEOUT, DEFAULT_LIMITS, docker, dockerAsync, ensureEnv, requireDocker, runArgv, stepTimeout }
  from "./sandbox";
import { randomHex } from "./util";

/** Seconds an index may take (Phase 0, 2026-10-25: 7–46 s per project). */
export const INDEX_TIMEOUT = 180;
/** Part of the layer's image tag: a new indexer version builds a new layer. */
export const LAYER_VERSION = "scip1";

const OUT = "/arnx-index/index.scip";
// Node and the npm indexers come from the official Node image; the binary runs on the Debian-based images projects use.
const nodeLayer = (pkg: string) => (env: string) => ["FROM node:22-bookworm-slim AS indexer",
  `RUN npm install -g --no-audit --no-fund --prefix /opt/arnx-index ${pkg} && cp /usr/local/bin/node /opt/arnx-index/bin/node`,
  `FROM ${env}`, "COPY --from=indexer /opt/arnx-index /opt/arnx-index", "ENV PATH=/opt/arnx-index/bin:$PATH"];

export const INDEXERS: Partial<Record<AdapterId, { layer: (env: string) => string[]; command: string }>> = {
  python: { layer: nodeLayer("@sourcegraph/scip-python@0.6.6"),
    command: `scip-python index . --project-name arnx --project-version 0 --output ${OUT}` },
  typescript: { layer: nodeLayer("@sourcegraph/scip-typescript@0.4.0"),
    command: `scip-typescript index --output ${OUT} || scip-typescript index --infer-tsconfig --output ${OUT}` },
  rust: { layer: (env) => [`FROM ${env}`, "USER root",
    // rust-src: without the standard library's sources, `std::fmt` and the like are not in the index.
    "RUN rustup component add rust-analyzer rust-src && chmod -R a+rwX /usr/local/rustup"],
    command: `CARGO_NET_OFFLINE=true rust-analyzer scip . --output ${OUT}` },
};

/** The environment image with the indexer added, built once per environment image and indexer version. */
async function indexImage(env: string, layer: string[]): Promise<string> {
  const tag = `${env}-${LAYER_VERSION}`;
  if (docker(["image", "inspect", tag]).status === 0) return tag;
  const r = await dockerAsync(["build", "-t", tag, "-"], { timeout: stepTimeout(BUILD_TIMEOUT),
    stdin: layer.join("\n") + "\n" });
  if (r.status !== 0) throw new Error(`the indexer layer did not build: ${(r.stderr || r.stdout).trim().slice(-300)}`);
  return tag;
}

/** TypeScript projects keep dependencies outside /src and link them in test_command; the indexer needs the same links. */
const links = (testCommand: string) => testCommand.split(/;|&&/).map((c) => c.trim()).filter((c) => /^ln\s/.test(c));

export interface IndexResult { index: ScipIndex | null; secs: number; reason?: string }

/** Indexes `cfg`'s project in `snap`; document paths come back relative to the repository. */
export async function projectIndex(cfg: ReviewConfig, snap: string, outDir: string): Promise<IndexResult> {
  const t0 = performance.now();
  const secs = () => Math.round((performance.now() - t0) / 100) / 10;
  const done = (r: IndexResult): IndexResult => {
    emit("context.index", { project: cfg.name, ok: !!r.index, secs: r.secs, ...(r.reason ? { reason: r.reason } : {}),
      ...(r.index ? { files: r.index.byFileLine.size } : {}) });
    return r;
  };
  const spec = INDEXERS[cfg.language];
  if (!spec) return done({ index: null, secs: 0, reason: `no indexer for ${cfg.language}` });
  const dir = join(outDir, "index");
  const name = `arnx-index-${randomHex(6)}`;
  try {
    requireDocker();
    mkdirSync(dir, { recursive: true });
    rmSync(join(dir, "index.scip"), { force: true });
    const env = await ensureEnv(cfg, snap, join(outDir, "env-build.log"));
    const image = await indexImage(env, spec.layer(env));
    const [, ...args] = runArgv({ image, name, network: "none", snapshot: snap, workdir: cfg.workdir, env: cfg.env,
      command: [...links(cfg.testCommand), spec.command].join("; "), limits: DEFAULT_LIMITS,
      user: `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`, runEnv: adapterFor(cfg).runEnv,
      mounts: [`${dir}:/arnx-index`] });
    let r;
    try {
      r = await dockerAsync(args, { timeout: stepTimeout(INDEX_TIMEOUT) });
    } catch (e) {
      docker(["rm", "-fv", name]);
      throw e;
    }
    if (r.status !== 0) throw new Error(`the indexer exited with ${r.status}: ${(r.stderr || r.stdout).trim().slice(-300)}`);
    const wd = posix.normalize(cfg.workdir).replace(/^\.\/?$/, "").replace(/\/$/, "");
    const index = readIndex(readFileSync(join(dir, "index.scip")), wd ? `${wd}/` : "");
    if (!index.byFileLine.size) throw new Error("the index holds no files");
    return done({ index, secs: secs() });
  } catch (e) {
    return done({ index: null, secs: secs(), reason: e instanceof Error ? e.message : String(e) });
  }
}
