import { readFileSync } from "node:fs";
import { join } from "node:path";

export const GOLDEN = join(import.meta.dir, "..", "fixtures", "golden");
export const golden = (name: string) => readFileSync(join(GOLDEN, name), "utf8");
