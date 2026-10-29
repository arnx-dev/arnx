// Tests that need a browser, and web UI apps: setup never sets up Playwright, Cypress, Storybook or vitest's browser
// mode (they are listed under uncovered as browser tests), and gives a web UI app one try at its node or jsdom unit
// tests. Both are found from file names and a few lines of configuration, without a model.
import { posix } from "node:path";

/** What a browser suite is listed under uncovered with. */
export const BROWSER_TESTS = "browser tests";
/** What a web UI app whose one try failed is listed under uncovered with. */
export const WEB_UI = "web UI";

/** A path pattern (as in uncovered) holding a suite that runs in a browser, and the tool that runs it. */
export interface BrowserSuite { path: string; tool: string }

const CONFIG_EXT = "(?:[cm]?[jt]s)";
const PLAYWRIGHT = new RegExp(`^playwright(?:-ct)?\\.config\\.${CONFIG_EXT}$`);
const CYPRESS = new RegExp(`^cypress\\.(?:config\\.${CONFIG_EXT}|json)$`);
const VITEST = new RegExp(`^(?:vitest|vite)\\.(?:config|workspace)\\.${CONFIG_EXT}$|^vitest\\.workspace\\.json$`);
/** `browser: { … enabled: true … }` in a vitest configuration or workspace. */
const BROWSER_MODE = /\bbrowser\s*:\s*\{[^}]*\benabled\s*:\s*true\b/s;
const TEST_DIR = /\btestDir\s*:\s*(['"`])([^'"`\n]+)\1/;
const STORIES = /\.stories\.[cm]?[jt]sx?$|\.stories\.mdx$/;

const anchored = (dir: string) => `/${dir}/`;

/** The browser suites among `files` (paths relative to the repository); `read` gives a file's text ("" when it cannot
 * be read). Each suite is named by where its tests are when that can be told, and by its configuration file. */
export function browserSuites(files: string[], read: (path: string) => string): BrowserSuite[] {
  const out: BrowserSuite[] = [];
  const add = (path: string, tool: string) => {
    if (!out.some((s) => s.path === path)) out.push({ path, tool });
  };
  const under = (dir: string) => files.some((f) => f.startsWith(`${dir}/`));
  const join = (dir: string, name: string) => (dir === "." ? name : `${dir}/${name}`);
  for (const f of files) {
    if (f.split("/").includes("node_modules")) continue;
    const dir = posix.dirname(f), name = posix.basename(f);
    if (PLAYWRIGHT.test(name)) {
      const m = TEST_DIR.exec(read(f));
      const tests = m ? posix.normalize(join(dir, m[2]!)).replace(/\/+$/, "") : join(dir, "e2e");
      // A testDir that is the configuration's own folder would take in the whole project: the file alone then.
      if (tests !== dir && tests !== "." && !tests.startsWith("..") && under(tests)) add(anchored(tests), "Playwright");
      add(`/${f}`, "Playwright");
    } else if (CYPRESS.test(name)) {
      if (under(join(dir, "cypress"))) add(anchored(join(dir, "cypress")), "Cypress");
      add(`/${f}`, "Cypress");
    } else if (dir.split("/").at(-1) === ".storybook") {
      add(anchored(dir), "Storybook");
      const root = posix.dirname(dir);
      if (files.some((s) => (root === "." || s.startsWith(`${root}/`)) && STORIES.test(s))) {
        add(root === "." ? "/**/*.stories.*" : `/${root}/**/*.stories.*`, "Storybook");
      }
    } else if (VITEST.test(name) && BROWSER_MODE.test(read(f))) {
      add(`/${f}`, "vitest browser mode");
    }
  }
  return out;
}

/** UI frameworks that make a package a web UI app when they are among its runtime dependencies. */
export const UI_FRAMEWORKS = ["react-dom", "next", "vue", "svelte", "@angular/core", "solid-js", "preact", "nuxt",
  "@sveltejs/kit", "astro", "electron"];

/** The UI framework a package.json lists among its runtime dependencies, or null (also when it does not read). */
export function uiFramework(packageJson: string): string | null {
  try {
    const deps = (JSON.parse(packageJson) as { dependencies?: Record<string, unknown> }).dependencies;
    return deps && typeof deps === "object" ? UI_FRAMEWORKS.find((n) => n in deps) ?? null : null;
  } catch {
    return null;
  }
}
