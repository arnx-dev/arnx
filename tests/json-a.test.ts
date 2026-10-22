// --json for init, doctor, next, consent, cloud, login, logout and credits: one object on stdout with each command's
// fields (skills/arnx/references/json.md), the human text on stderr, nothing asked, no real network.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeCredentials } from "../src/cloud";
import { parseReviewFile, stampFile } from "../src/config";
import { Cli } from "./helpers/cli";
import { type FakeCloud, fakeCloud, TOKEN } from "./helpers/cloudfake";
import { commit, gitRepo } from "./helpers/gitutil";
import { useTmp } from "./helpers/tmp";
import { PROJECTS } from "./helpers/yaml";

const tmp = useTmp();
let cloud: FakeCloud | null = null;
afterEach(() => {
  cloud?.stop();
  cloud = null;
});
const noWait = async () => {};
const json = (cli: Cli) => JSON.parse(cli.stdout) as Record<string, unknown>;

test("init --json: created, then already-initialized; one object on stdout, the text on stderr", async () => {
  const repo = gitRepo(tmp());
  const cli = new Cli({ cwd: repo, ask: async () => { throw new Error("asked"); } });
  expect(await cli.run("init", "--json")).toBe(0);
  expect(cli.out).toHaveLength(1);
  expect(json(cli)).toEqual({ schema_version: 1, command: "init", result: "ok", exit_code: 0, state: "created",
    files: [{ path: ".arnx/config.toml", action: "created" }, { path: ".arnxignore", action: "created" }],
    cloud: false, next: ["arnx setup"], skill_installed: false });
  expect(cli.stderr).toStartWith("✓ arnx initialized\n");
  expect(cli.stderr).toContain("Next: arnx setup");
  const again = new Cli({ cwd: repo });
  expect(await again.run("init", "--json")).toBe(0);
  expect(json(again)).toMatchObject({ state: "already-initialized",
    files: [{ path: ".arnx/config.toml", action: "kept" }, { path: ".arnxignore", action: "kept" }] });
  const force = new Cli({ cwd: repo });
  await force.run("init", "--force", "--json");
  expect(json(force)).toMatchObject({ state: "replaced", files: [{ action: "replaced" }, { action: "kept" }] });
});

test("init --cloud --json: login first, then setup", async () => {
  const repo = gitRepo(tmp());
  const cli = new Cli({ cwd: repo, env: { HOME: tmp(), ARNX_CLOUD_URL: "http://127.0.0.1:9" } });
  expect(await cli.run("init", "--cloud", "--json")).toBe(0);
  expect(json(cli)).toMatchObject({ state: "created", cloud: true, next: ["arnx login", "arnx setup"] });
});

test("doctor --json not ready: every check, a ✗ means no next command", async () => {
  const repo = gitRepo(tmp());
  await new Cli({ cwd: repo }).run("init");
  const cli = new Cli({ cwd: repo, env: {}, dockerOk: () => [false, "Docker is not running"] });
  expect(await cli.run("doctor", "--json")).toBe(3);
  const o = json(cli);
  expect(o).toMatchObject({ command: "doctor", result: "not-ready", exit_code: 3, ready: false, next: null,
    models: "byom", providers: [], telemetry: { enabled: false, reason: "in this build" } });
  expect(o.checks).toEqual([
    { name: "configuration", ok: true, detail: "valid" },
    { name: "models", ok: true, detail: "BYOM" },
    { name: "keys", ok: false, detail: expect.stringContaining("missing ANTHROPIC_API_KEY") },
    { name: "docker", ok: false, detail: "not running" },
    { name: "consent", ok: null, detail: "pending" },
    { name: "environment", ok: null, detail: "not configured" },
  ]);
  expect(o).not.toHaveProperty("coverage");
  expect(cli.stderr).toContain("Not ready for review.");
  // Nothing failing, steps still to do: not ready, and the next command named.
  const pending = new Cli({ cwd: repo, env: { ANTHROPIC_API_KEY: "a" } });
  expect(await pending.run("doctor", "--json")).toBe(3);
  expect(json(pending)).toMatchObject({ result: "not-ready", ready: false, next: "arnx setup" });
});

test("doctor --json ready: coverage per project, JEV and telemetry", async () => {
  const repo = gitRepo(tmp());
  mkdirSync(join(repo, "services", "pay"), { recursive: true });
  writeFileSync(join(repo, "services", "pay", "a.py"), "X = 1\n");
  commit(repo, "pay");
  const env = { ANTHROPIC_API_KEY: "a", JEV_API_KEY: "j", HOME: tmp() };
  const cli = new Cli({ cwd: repo, env, telemetryOpen: true });
  await cli.run("init");
  await cli.run("consent", "--yes");
  writeFileSync(join(repo, ".arnx", "review.yaml"), stampFile(parseReviewFile(PROJECTS), "Dev", "2026-10-12"));
  cli.out = [];
  cli.err = [];
  expect(await cli.run("doctor", "--json")).toBe(0);
  const o = json(cli);
  expect(o).toMatchObject({ result: "ready", exit_code: 0, ready: true, next: "arnx review", models: "byom",
    jev: { on: false, key_set: true }, telemetry: { enabled: false,
      reason: "telemetry = true in .arnx/config.toml turns it on" } });
  expect((o.checks as { ok: unknown }[]).every((c) => c.ok === true)).toBe(true);
  const cov = o.coverage as { projects: unknown[]; uncovered: { path: string }[]; unexplained: string[] };
  expect(cov.projects).toContainEqual({ name: "pay", owned: 1, used: 0, untracked: { owned: 0, used: 0 } });
  expect(cov.uncovered.map((u) => u.path)).toContain("infra/");
  expect(cov.unexplained).toHaveLength(1);
  expect(cli.stderr).toContain("Ready for review.");
});

test("next --json: where, next, why, then, note, phase", async () => {
  const repo = gitRepo(tmp());
  const cli = new Cli({ cwd: repo });
  expect(await cli.run("next", "--json")).toBe(0);
  expect(json(cli)).toEqual({ schema_version: 1, command: "next", result: "ok", exit_code: 0,
    where: "not set up", next: "arnx init", why: "writes .arnx/config.toml and .arnxignore", then: null, note: null,
    phase: "1. Prepare" });
});

test("consent --json: which consent, when, to whom; declined without --yes is an error object", async () => {
  const repo = gitRepo(tmp());
  await new Cli({ cwd: repo }).run("init");
  const cli = new Cli({ cwd: repo });
  expect(await cli.run("consent", "--cloud", "--yes", "--json")).toBe(0);
  const o = json(cli);
  expect(o).toMatchObject({ result: "ok", recorded: "cloud_consent_at", to: "arnx cloud" });
  expect(o.at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/);
  const plain = new Cli({ cwd: repo });
  await plain.run("consent", "--yes", "--json");
  expect(json(plain)).toMatchObject({ recorded: "consent_at", to: "your model provider" });
  const no = new Cli({ cwd: repo });
  expect(await no.run("consent", "--json")).toBe(3);
  expect(json(no)).toMatchObject({ result: "error", error: "consent declined; nothing written" });
});

test("cloud on|off --json: the models after the change, the next commands, the missing keys", async () => {
  const c = cloud = fakeCloud();
  const repo = gitRepo(tmp());
  const home = tmp();
  const env = { HOME: home, ARNX_CLOUD_URL: c.url };
  await new Cli({ cwd: repo, env }).run("init");
  const on = new Cli({ cwd: repo, env });
  expect(await on.run("cloud", "on", "--yes", "--json")).toBe(0);
  expect(json(on)).toMatchObject({ command: "cloud", result: "ok", models: true, already_on: false, logged_in: false,
    next: ["arnx login", "arnx setup"] });
  writeCredentials({ HOME: home }, { url: c.url, token: TOKEN });
  const again = new Cli({ cwd: repo, env });
  await again.run("cloud", "on", "--json");
  expect(json(again)).toMatchObject({ models: true, already_on: true, logged_in: true, next: ["arnx setup"] });
  const off = new Cli({ cwd: repo, env });
  expect(await off.run("cloud", "off", "--json")).toBe(0);
  expect(json(off)).toMatchObject({ models: false, next: ["arnx doctor"], missing_keys: ["ANTHROPIC_API_KEY"] });
  expect(c.seen).toHaveLength(0);
});

test("login, credits and logout --json", async () => {
  const c = cloud = fakeCloud({ balance: 4_250_000 });
  const home = tmp();
  const env = { HOME: home, ARNX_CLOUD_URL: c.url };
  const login = new Cli({ cwd: home, env, sleep: noWait });
  expect(await login.run("login", "--json")).toBe(0);
  expect(json(login)).toMatchObject({ command: "login", result: "ok", email: "dev@example.com", url: c.url });
  expect(login.stderr).toContain("ABCD-1234");
  const credits = new Cli({ cwd: home, env });
  expect(await credits.run("credits", "--json")).toBe(0);
  expect(json(credits)).toMatchObject({ result: "ok", balance_usd: 4.25, held_usd: 0, reserved_usd: 0,
    email: "dev@example.com",
    topup_url: "https://arnx.dev/credits" });
  const logout = new Cli({ cwd: home, env });
  expect(await logout.run("logout", "--json")).toBe(0);
  expect(json(logout)).toMatchObject({ result: "ok", deleted: true, path: "~/.config/arnx/credentials.json" });
  const twice = new Cli({ cwd: home, env });
  await twice.run("logout", "--json");
  expect(json(twice)).toMatchObject({ deleted: false });
  const out = new Cli({ cwd: home, env });
  expect(await out.run("credits", "--json")).toBe(3);
  expect(json(out)).toMatchObject({ result: "error", exit_code: 3 });
});
