// The repository root is a Claude Code plugin marketplace (`/plugin marketplace add arnx-dev/arnx`) listing one plugin
// that lives in plugin/, so a directory review sees only the plugin. `claude plugin validate ./plugin` checks the format.
import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { SKILL_FILES } from "../src/skill";
import { VERSION } from "../src/version";

const ROOT = join(import.meta.dir, "..");
const PLUGIN = join(ROOT, "plugin");

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; });

const TEXT = /\.(md|txt|json|ya?ml)$/i;
const IMAGE = /\.(png|jpe?g|gif|webp|ico)$/i;

test("the plugin folder holds only allowed file types", () => {
  expect(existsSync(PLUGIN)).toBe(true);
  const files = walk(PLUGIN);
  expect(files.length).toBeGreaterThan(0);
  for (const f of files) {
    const rel = relative(PLUGIN, f);
    const name = rel.split("/").pop()!;
    const isText = TEXT.test(name) || name === "LICENSE";
    expect(isText || IMAGE.test(name), rel).toBe(true);
    expect(["package.json", "bun.lock", "bun.lockb", "package-lock.json", "yarn.lock", "pnpm-lock.yaml"]).not.toContain(name);
    const bytes = readFileSync(f);
    if (isText) {
      expect(bytes.includes(0), `${rel} has a NUL byte`).toBe(false);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      expect(text.startsWith("#!"), `${rel} starts with #!`).toBe(false);
    } else {
      expect(bytes.subarray(0, 2).toString("latin1"), `${rel} starts with #!`).not.toBe("#!");
    }
  }
});

test("the marketplace points at the plugin folder", () => {
  const market = JSON.parse(readFileSync(join(ROOT, ".claude-plugin", "marketplace.json"), "utf8"));
  expect(market.name).toBe("arnx");
  expect(market.owner.name).toBeTruthy();
  expect(market.plugins).toHaveLength(1);
  expect(market.plugins[0]).toMatchObject({ name: "arnx", source: "./plugin" });
  expect(existsSync(join(ROOT, ".claude-plugin", "plugin.json"))).toBe(false);
  const manifest = JSON.parse(readFileSync(join(PLUGIN, ".claude-plugin", "plugin.json"), "utf8"));
  expect(manifest.name).toBe("arnx");
  expect(manifest.icon).toBe("./icon.png");
  const png = readFileSync(join(PLUGIN, "icon.png"));
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(existsSync(join(PLUGIN, "skills", "arnx", "SKILL.md"))).toBe(true);
});

test("the plugin version is the CLI version", () => {
  const manifest = JSON.parse(readFileSync(join(PLUGIN, ".claude-plugin", "plugin.json"), "utf8"));
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  expect(manifest.version).toBe(pkg.version);
  expect(manifest.version).toBe(VERSION); // released with the CLI: a release bumps both
});

test("the skill the CLI installs is the plugin's skill", () => {
  const dir = join(PLUGIN, "skills", "arnx");
  expect(SKILL_FILES["SKILL.md"]).toBe(readFileSync(join(dir, "SKILL.md"), "utf8"));
  expect(Object.keys(SKILL_FILES).sort()).toEqual(walk(dir).map((f) => relative(dir, f)).sort());
});
