import { ArnxError } from "../errors";
import { python } from "./python";
import { rust } from "./rust";
import { typescript } from "./typescript";
import type { Adapter, AdapterId } from "./types";

export type { Adapter, AdapterId, TestResult } from "./types";
export const LANGUAGES: AdapterId[] = ["python", "typescript", "rust", "csharp"];
const ADAPTERS: Partial<Record<AdapterId, Adapter>> = { python, typescript, rust };

export function getAdapter(id: string): Adapter {
  if (!(LANGUAGES as string[]).includes(id)) {
    throw new ArnxError(`unknown language ${JSON.stringify(id)}; arnx knows ${LANGUAGES.join(", ")}`);
  }
  const adapter = ADAPTERS[id as AdapterId];
  if (!adapter) {
    const ready = Object.keys(ADAPTERS).join(", ");
    throw new ArnxError(`language ${id}: not supported in this version of arnx (${ready} only)`);
  }
  return adapter;
}

export function adapterFor(cfg: { language: AdapterId }): Adapter {
  return getAdapter(cfg.language);
}
