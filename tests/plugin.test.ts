// The repository root is a Claude Code plugin marketplace (`/plugin marketplace add arnx-dev/arnx`) listing one plugin,
// the repository itself, whose default skills/ folder holds the arnx skill. `claude plugin validate .` checks the format.
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "../src/version";

const ROOT = join(import.meta.dir, "..");

test("the repository is a Claude Code plugin marketplace whose one plugin is the repository, carrying skills/arnx", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, ".claude-plugin", "plugin.json"), "utf8"));
  const market = JSON.parse(readFileSync(join(ROOT, ".claude-plugin", "marketplace.json"), "utf8"));
  expect(manifest.name).toBe("arnx");
  expect(manifest.version).toBe(VERSION); // released with the CLI: a release bumps both
  expect(market.name).toBe("arnx");
  expect(market.owner.name).toBeTruthy();
  expect(market.plugins).toHaveLength(1);
  expect(market.plugins[0]).toMatchObject({ name: manifest.name, source: "./" });
  // The plugin's default skills/ folder is the one the CLI embeds.
  expect(existsSync(join(ROOT, "skills", "arnx", "SKILL.md"))).toBe(true);
});
