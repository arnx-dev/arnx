// The coverage map against the code: a review reaches a project through the files it owns and uses, so a `uses`
// entry its code never references reviews it for nothing (a catch-all `packages/`, an unanchored `lib/` matching
// `packages/lib/`), and a file its code references but neither owns nor uses leaves changes there unreviewed by it.
// Read from the projects' code indexes; it sees code only (an import of a YAML file is not in them), so these are
// hints for the setup agent, never refusals on their own. mapHints needs no index: the map's paths alone.
import { posix } from "node:path";
import type { ReviewFile } from "./config";
import { matcher } from "./ignore";
import { DEFINITION, type ScipIndex } from "./scip";

export interface UsesHint { project: string; kind: "unreferenced" | "missing" | "uncovered" | "unanchored" | "catch-all";
  text: string; entry?: string }

/** File -> the other files whose definitions it refers to, over every index given (paths relative to the repository). */
export function fileReferences(indexes: ScipIndex[]): Map<string, Set<string>> {
  const definedIn = new Map<string, string>();
  for (const ix of indexes) {
    for (const [symbol, occs] of ix.bySymbol) {
      const def = occs.find((o) => o.roles & DEFINITION);
      if (def && !definedIn.has(symbol)) definedIn.set(symbol, def.file);
    }
  }
  const out = new Map<string, Set<string>>();
  for (const ix of indexes) {
    for (const [file, lines] of ix.byFileLine) {
      const to = out.get(file) ?? out.set(file, new Set()).get(file)!;
      for (const occs of lines.values()) {
        for (const o of occs) {
          const g = o.roles & DEFINITION ? undefined : definedIn.get(o.symbol);
          if (g && g !== file) to.add(g);
        }
      }
    }
  }
  return out;
}

const folder = (f: string) => {
  const parts = f.split("/");
  return parts.length > 2 && ["packages", "apps", "libs", "crates", "services"].includes(parts[0]!)
    ? `${parts.slice(0, 2).join("/")}/` : parts.length > 1 ? `${parts[0]}/` : f;
};
const few = (xs: string[]) => xs.slice(0, 3).join(", ") + (xs.length > 3 ? `, and ${xs.length - 3} more` : "");

/** Hints for `file`'s map from the file references of its projects' code (`refs`, fileReferences). Only files the
 * indexes hold count: a uses entry whose files no index reached is not judged. */
export function usesHints(file: ReviewFile, refs: Map<string, Set<string>>): UsesHint[] {
  const indexed = [...refs.keys()];
  const hints: UsesHint[] = [];
  const projects = file.projects.map((p) => ({ p, owns: matcher(p.owns.join("\n")), uses: matcher(p.uses.join("\n")) }));
  for (const { p, owns, uses } of projects) {
    const owned = indexed.filter((f) => owns(f));
    if (!owned.length) continue;
    // What its code reaches: what its owned files refer to, and on through what those refer to.
    const reach = new Set<string>(), queue = [...owned];
    while (queue.length) {
      for (const g of refs.get(queue.pop()!) ?? []) {
        if (!reach.has(g)) {
          reach.add(g);
          queue.push(g);
        }
      }
    }
    for (const entry of p.uses) {
      const m = matcher(entry);
      const matched = indexed.filter((f) => !owns(f) && m(f));
      if (!matched.length || matched.some((f) => reach.has(f))) continue;
      const where = [...new Set(matched.map(folder))];
      // An entry without a leading slash matches at any depth: `lib/` also takes in `packages/lib/`.
      const top = posix.normalize(entry.replace(/^\/+/, ""));
      const unanchored = !entry.startsWith("/") && matched.some((f) => !f.startsWith(top));
      hints.push({ project: p.name, kind: "unreferenced", entry, text: `${p.name}: its code never refers to the ` +
        `${matched.length} source file${matched.length === 1 ? "" : "s"} uses ${entry} matches (${few(where)}); ` +
        (unanchored ? `if you meant the top-level folder, anchor it (/${top})` : "drop it unless the project depends " +
          "on them in a way code does not show (a file it reads, a contract it mirrors)") });
    }
    const missing = [...reach].filter((g) => !owns(g) && !uses(g) && owned.some((f) => refs.get(f)?.has(g)));
    const byFolder = new Map<string, string[]>();
    for (const g of missing) byFolder.set(folder(g), [...(byFolder.get(folder(g)) ?? []), g]);
    for (const [where, gs] of byFolder) {
      hints.push({ project: p.name, kind: "missing", text: `${p.name}: its code refers to ${few(gs)}, which it ` +
        `neither owns nor uses, so a change there is not reviewed with it; add ${where} to its uses` });
    }
  }
  for (const u of file.uncovered) {
    const m = matcher(u.path);
    const by = projects.filter(({ owns }) => indexed.some((f) => owns(f) && [...(refs.get(f) ?? [])].some((g) => m(g))))
      .map(({ p }) => p.name);
    if (by.length) {
      hints.push({ project: by[0]!, kind: "uncovered", text: `${u.path} is listed under uncovered, but the code of ` +
        `${by.join(", ")} refers to it: add it to their uses` });
    }
  }
  return hints;
}

/** Hints for `file`'s map from its paths alone (`files`: the repository's files): a folder entry with no slash but
 * its trailing one matches at any depth, so one that matches in several places (`api/` and `packages/api/`) is
 * probably meant for one of them (a file name or a glob matching several files is meant to); and an entry that takes in two or more other projects whole (a catch-all `services/`) has
 * every change in them reviewed twice. */
export function mapHints(file: ReviewFile, files: string[]): UsesHint[] {
  const hints: UsesHint[] = [];
  const projects = file.projects.map((p) => ({ p, owns: matcher(p.owns.join("\n")) }));
  for (const { p, owns } of projects) {
    for (const entry of p.uses) {
      const m = matcher(entry);
      const matched = files.filter((f) => !owns(f) && m(f));
      if (!matched.length) continue;
      if (/^[^/*?[]+\/+$/.test(entry)) {
        // Where each file is matched: the folder the entry names on its path.
        const places = [...new Set(matched.map((f) => {
          const parts = f.split("/");
          return `${parts.slice(0, parts.findIndex((_, i) => m(`${parts.slice(0, i + 1).join("/")}/`)) + 1).join("/")}/`;
        }))].sort();
        if (places.length > 1) {
          hints.push({ project: p.name, kind: "unanchored", entry, text: `${p.name}: uses ${entry} matches in ` +
            `${places.length} places (${few(places)}); anchor it to the one meant (${few(places.map((x) => `/${x}`))})` });
        }
      }
      const whole = projects.filter((o) => o.p !== p && files.some((f) => o.owns(f)) &&
        files.every((f) => !o.owns(f) || m(f))).map((o) => o.p.name);
      if (whole.length > 1) {
        hints.push({ project: p.name, kind: "catch-all", entry, text: `${p.name}: uses ${entry} takes in ` +
          `${whole.length} other projects whole (${few(whole)}), so every change in them is reviewed by ${p.name} too ` +
          `(duplicate findings, double cost); narrow it to what ${p.name} depends on` });
      }
    }
  }
  return hints;
}
