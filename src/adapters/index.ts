import { ArnxError } from "../errors";
import { python } from "./python";
import { rust } from "./rust";
import { typescript, withTestFiles } from "./typescript";
import type { Adapter, AdapterId } from "./types";

export type { Adapter, AdapterId, TestResult } from "./types";
export const LANGUAGES: AdapterId[] = ["python", "typescript", "rust", "csharp"];
const ADAPTERS: Partial<Record<AdapterId, Adapter>> = { python, typescript, rust };

export function getAdapter(id: string): Adapter {
  if (!(LANGUAGES as string[]).includes(id)) {
    throw new ArnxError(`unknown language ${JSON.stringify(id)}; arnx reviews ${Object.keys(ADAPTERS).join(", ")}`);
  }
  const adapter = ADAPTERS[id as AdapterId];
  if (!adapter) {
    const ready = Object.keys(ADAPTERS).join(", ");
    throw new ArnxError(`language ${id}: not supported in this version of arnx (${ready} only)`);
  }
  return adapter;
}

/** The project's adapter. A project whose runner collects only test files named another way (test_files: "*Spec.tsx",
 * TypeScript only) gets the adapter with the names arnx writes, probes, collects and keeps changed to that. */
export function adapterFor(cfg: { language: AdapterId; testFiles?: string }): Adapter {
  const adapter = getAdapter(cfg.language);
  return cfg.testFiles && cfg.language === "typescript" ? withTestFiles(adapter, cfg.testFiles) : adapter;
}
