// The names `arnx accept` stores kept files under in .arnx/tests/: each file's whole name with KEPT_SUFFIX appended
// (`x.test.ts` → `x.test.ts.arnx`, `conftest.py` → `conftest.py.arnx`), which no test runner, type checker or linter
// picks up. Only `arnx check` puts them in place under the names they run by, in its throwaway copy. The only place
// that builds or strips the suffix.

/** What `arnx accept` appends to the whole name of every file it keeps under .arnx/tests/. Files an older arnx kept
 * without it are read too. */
export const KEPT_SUFFIX = ".arnx";

/** The name a kept file is stored under in .arnx/tests/, from the name it runs by. */
export function storedName(run: string): string {
  return run + KEPT_SUFFIX;
}

/** The name a kept file runs by, from the name it is stored under (one an older arnx stored as it runs is that). */
export function runName(stored: string): string {
  return stored.endsWith(KEPT_SUFFIX) ? stored.slice(0, -KEPT_SUFFIX.length) : stored;
}
