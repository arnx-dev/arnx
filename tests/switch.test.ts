// Switching between the user's own keys and arnx cloud: the committed `[cloud] models` is the team's default, and a
// person or a run overrides it with ARNX_MODELS or --local / --cloud, without the file being rewritten. Sending code to
// arnx cloud needs its own consent, asked once and recorded as cloud_consent_at.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DOCKER_LINE, sendQuestion } from "../src/cli";
import { parseReviewFile, reviewConfigPath, stampFile } from "../src/config";
import { writeCredentials } from "../src/cloud";
import { ArnxError } from "../src/errors";
import { save } from "../src/report";
import { cloudModels, defaultSettings, loadSettings, modelsMode, settingsPath, withModels, writeSettings }
  from "../src/settings";
import { Cli } from "./helpers/cli";
import { type FakeCloud, fakeCloud, TOKEN } from "./helpers/cloudfake";
import { commit, gitRepo } from "./helpers/gitutil";
import { sampleReview } from "./helpers/review";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
let cloud: FakeCloud | null = null;
afterEach(() => {
  cloud?.stop();
  cloud = null;
});

test("the models in effect: a flag beats ARNX_MODELS, which beats the file", () => {
  const local = defaultSettings();
  const onCloud = { ...local, cloud: { models: true, tests: false, effort: "high" as const } };
  expect(modelsMode(local, {})).toEqual({ cloud: false, from: "file" });
  expect(modelsMode(onCloud, {})).toEqual({ cloud: true, from: "file" });
  expect(modelsMode(onCloud, { ARNX_MODELS: "" })).toEqual({ cloud: true, from: "file" }); // empty is unset
  expect(modelsMode(onCloud, { ARNX_MODELS: "local" })).toEqual({ cloud: false, from: "ARNX_MODELS" });
  expect(modelsMode(local, { ARNX_MODELS: " cloud " })).toEqual({ cloud: true, from: "ARNX_MODELS" });
  expect(modelsMode(local, { ARNX_MODELS: "cloud" }, "local")).toEqual({ cloud: false, from: "flag" });
  expect(modelsMode(onCloud, { ARNX_MODELS: "local" }, "cloud")).toEqual({ cloud: true, from: "flag" });
  // The override keeps the rest of [cloud] (the tier), and a file without the table gets the default one.
  expect(withModels(onCloud, { cloud: false, from: "flag" }).cloud).toEqual({ models: false, tests: false,
    effort: "high" });
  expect(withModels({ ...local, cloud: undefined }, { cloud: true, from: "ARNX_MODELS" }).cloud).toEqual(
    { models: true, tests: false, effort: "medium" });
  expect(cloudModels(withModels(local, { cloud: false, from: "file" }))).toBe(false);
});

test("an ARNX_MODELS that is neither local nor cloud is an error naming both", async () => {
  expect(() => modelsMode(defaultSettings(), { ARNX_MODELS: "byok" })).toThrow(ArnxError);
  expect(() => modelsMode(defaultSettings(), { ARNX_MODELS: "byok" }))
    .toThrow('ARNX_MODELS: "byok"; write "local" (your own keys) or "cloud" (arnx models)');
  const repo = gitRepo(tmp());
  const cli = new Cli({ cwd: repo, env: { ARNX_MODELS: "Cloud" } });
  await cli.run("init");
  expect(await cli.run("review")).toBe(2);
  expect(cli.stderr).toContain('ARNX_MODELS: "Cloud"; write "local" (your own keys) or "cloud" (arnx models)');
  // A flag decides on its own: the variable is not read then.
  expect(await cli.run("doctor", "--local")).toBe(3);
  expect(cli.stdout).toContain("✓ Models: BYOM (from --local)");
  cli.out = [];
  expect(await cli.run("doctor")).toBe(3);
  expect(cli.stdout).toContain('✗ Models: ARNX_MODELS: "Cloud"; write "local" (your own keys) or "cloud" (arnx models)');
  expect(cli.stdout).not.toContain("Keys:");
  expect(cli.stdout).not.toContain("Login:");
});

test("--local and --cloud together are refused", async () => {
  const repo = gitRepo(tmp());
  const cli = new Cli({ cwd: repo });
  await cli.run("init");
  expect(await cli.run("review", "--local", "--cloud")).toBe(2);
  expect(cli.stderr).toContain("--local and --cloud cannot be used together");
  expect(await cli.run("check", "--cloud")).toBe(2); // only the commands that call models take it
});

test("doctor names the models in effect and what chose them; an override never rewrites the file", async () => {
  const c = cloud = fakeCloud({ balance: 1_000_000 });
  const repo = gitRepo(tmp());
  const home = tmp();
  writeCredentials({ HOME: home }, { url: c.url, token: TOKEN });
  const env = { HOME: home, ARNX_CLOUD_URL: c.url, ANTHROPIC_API_KEY: "a" };
  await new Cli({ cwd: repo, env }).run("init");
  const before = readFileSync(settingsPath(repo), "utf8");
  const doctor = async (extra: Record<string, string>, ...flags: string[]) => {
    const cli = new Cli({ cwd: repo, env: { ...env, ...extra } });
    await cli.run("doctor", ...flags);
    return cli.stdout;
  };
  const file = await doctor({});
  expect(file).toContain("✓ Models: BYOM\n");
  expect(file).toContain("✓ Keys: 1 required key present");
  expect(file).not.toContain("Login:");
  const env1 = await doctor({ ARNX_MODELS: "cloud" });
  expect(env1).toContain("✓ Models: arnx cloud (from ARNX_MODELS=cloud)");
  expect(env1).toContain(`✓ Login: logged in to ${c.url}`);
  expect(env1).not.toContain("Keys:");
  const flag = await doctor({ ARNX_MODELS: "cloud" }, "--local");
  expect(flag).toContain("✓ Models: BYOM (from --local)");
  expect(flag).toContain("✓ Keys: 1 required key present");
  expect(await doctor({}, "--cloud")).toContain("✓ Models: arnx cloud (from --cloud)");
  expect(readFileSync(settingsPath(repo), "utf8")).toBe(before);
});

test("ARNX_MODELS=local runs a file that says arnx cloud on the user's own keys", async () => {
  const repo = gitRepo(tmp());
  const env = { HOME: tmp(), ARNX_CLOUD_URL: "http://127.0.0.1:9" };
  await new Cli({ cwd: repo, env }).run("init", "--cloud");
  const cli = new Cli({ cwd: repo, env: { ...env, ARNX_MODELS: "local" } });
  // The local brain needs a key; with none set the review stops there, not at the arnx cloud login.
  expect(await cli.run("review")).toBe(3);
  expect(cli.stderr).toContain("missing ANTHROPIC_API_KEY: export it");
  expect(cli.stderr).not.toContain("arnx login");
  expect(readFileSync(settingsPath(repo), "utf8")).toContain("models = true ");
});

/** A repository set up with a plain init whose file was then switched by hand: `models = true`, no cloud consent. */
async function flipped(env: Record<string, string>): Promise<{ repo: string; before: string }> {
  const repo = gitRepo(tmp());
  await new Cli({ cwd: repo, env }).run("init");
  const text = readFileSync(settingsPath(repo), "utf8");
  writeFileSync(settingsPath(repo), text.replace("\nmodels = false ", "\nmodels = true  "));
  return { repo, before: readFileSync(settingsPath(repo), "utf8") };
}
const STAMP = /^cloud_consent_at = "\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[^"]*"$/m;
const without = (text: string, key: string) => text.split("\n").filter((l) => !l.startsWith(`${key} = `)).join("\n");

test("cloud_consent_at is read, written after consent_at only when set, and round-trips", () => {
  const repo = gitRepo(tmp());
  const s = { ...defaultSettings(), consentAt: "2026-10-20T00:00:00Z" };
  writeSettings(repo, s);
  expect(readFileSync(settingsPath(repo), "utf8")).not.toContain("cloud_consent_at");
  expect(loadSettings(repo).cloudConsentAt).toBeUndefined();
  const both = { ...s, cloudConsentAt: "2026-10-20T01:00:00Z" };
  writeSettings(repo, both);
  expect(readFileSync(settingsPath(repo), "utf8")).toStartWith('consent_at = "2026-10-20T00:00:00Z"\n' +
    'cloud_consent_at = "2026-10-20T01:00:00Z"\ntelemetry = false');
  expect(loadSettings(repo)).toEqual(both);
});

test("init --cloud records no consent: the first send asks arnx cloud's", async () => {
  const repo = gitRepo(tmp());
  expect(await new Cli({ cwd: repo, env: { HOME: tmp() } }).run("init", "--cloud")).toBe(0);
  const s = loadSettings(repo);
  expect([s.consentAt, s.cloudConsentAt, s.cloud?.models]).toEqual([null, undefined, true]);
});

test("models flipped by hand, no cloud consent: without a terminal arnx stops (exit 3) and sends nothing", async () => {
  const c = cloud = fakeCloud();
  const home = tmp();
  writeCredentials({ HOME: home }, { url: c.url, token: TOKEN });
  const env = { HOME: home, ARNX_CLOUD_URL: c.url };
  const { repo, before } = await flipped(env);
  const cli = new Cli({ cwd: repo, env });
  expect(await cli.run("review")).toBe(3);
  expect(cli.stderr).toBe("arnx: arnx models is on (`[cloud] models = true`), and sending code to arnx cloud has " +
    "not been agreed to; nothing sent: run `arnx consent --cloud`");
  // The same through the variable on a file that says the user's own keys.
  const plain = new Cli({ cwd: repo, env: { ...env, ARNX_MODELS: "cloud" } });
  writeFileSync(settingsPath(repo), before.replace("\nmodels = true  ", "\nmodels = false "));
  expect(await plain.run("review")).toBe(3);
  expect(plain.stderr).toContain("arnx models is on (ARNX_MODELS=cloud), and sending code to arnx cloud has not");
  // accept turns answers into tests with a model: the same gate (--no-answers calls none).
  save(sampleReview({ id: "20261020-a1b2c3", questions: ["Q?"] }), join(repo, ".arnx", "reviews", "20261020-a1b2c3"),
    "d");
  expect(await plain.run("accept")).toBe(3);
  expect(plain.stderr).toContain("arnx consent --cloud");
  expect(c.seen).toHaveLength(0);
});

test("models flipped by hand: at a terminal it asks once; no sends nothing, yes records it and goes on", async () => {
  const c = cloud = fakeCloud();
  const home = tmp();
  writeCredentials({ HOME: home }, { url: c.url, token: TOKEN });
  // No review.yaml: a review that goes on past the consent stops there, before arnx cloud is called.
  const env = { HOME: home, ARNX_CLOUD_URL: c.url };
  const { repo, before } = await flipped(env);
  const asked: string[] = [];
  const no = new Cli({ cwd: repo, env, interactive: true, ask: async (p) => { asked.push(p); return "n"; } });
  expect(await no.run("review")).toBe(3);
  expect(asked).toEqual(["Send your change and the files arnx reads to arnx cloud? [y/N] "]);
  expect(no.stderr).toBe("arnx: consent declined; nothing sent");
  expect(readFileSync(settingsPath(repo), "utf8")).toBe(before);
  const yes = new Cli({ cwd: repo, env, interactive: true, ask: async () => "y" });
  expect(await yes.run("review")).toBe(3);
  expect(yes.stdout).toBe(DOCKER_LINE);
  expect(yes.stderr).toContain("review.yaml"); // it went on past the consent
  const after = readFileSync(settingsPath(repo), "utf8");
  expect(after.split("\n")[0]).toMatch(STAMP); // first: there is no consent_at
  expect(without(after, "cloud_consent_at")).toBe(before); // nothing else changed
  // Asked once: the next run does not ask again.
  const again = new Cli({ cwd: repo, env, interactive: true, ask: async () => { throw new Error("asked again"); } });
  expect(await again.run("review")).toBe(3);
  expect(again.stdout).not.toContain(DOCKER_LINE);
  expect(c.seen).toHaveLength(0);
});

test("arnx consent --cloud --yes records only cloud_consent_at; arnx consent records consent_at", async () => {
  const repo = gitRepo(tmp());
  await new Cli({ cwd: repo }).run("init");
  // A hand edit (a comment, a changed budget) stays as it was.
  const edited = readFileSync(settingsPath(repo), "utf8").replace("review_usd = 3.0", "review_usd = 4.5  # ours");
  writeFileSync(settingsPath(repo), edited);
  const cli = new Cli({ cwd: repo });
  expect(await cli.run("consent", "--cloud", "--yes")).toBe(0);
  expect(cli.stdout).toContain(`${sendQuestion("arnx cloud")} yes (--yes)\n${DOCKER_LINE}`);
  expect(cli.stdout).toBe(`${sendQuestion("arnx cloud")} yes (--yes)\n${DOCKER_LINE}\n` +
    "✓ Consent recorded: code may go to arnx cloud");
  const once = readFileSync(settingsPath(repo), "utf8");
  expect(once.split("\n")[0]).toMatch(STAMP); // first, with no consent_at yet
  expect(without(once, "cloud_consent_at")).toBe(edited);
  expect(cloudModels(loadSettings(repo))).toBe(false); // consent turns nothing on
  // Again: the line is replaced, not added twice.
  expect(await cli.run("consent", "--cloud", "--yes")).toBe(0);
  expect(readFileSync(settingsPath(repo), "utf8").match(/^cloud_consent_at = /gm)).toHaveLength(1);
  // consent_at: added first, before cloud_consent_at.
  const noConsent = readFileSync(settingsPath(repo), "utf8");
  const plain = new Cli({ cwd: repo });
  expect(await plain.run("consent", "--yes")).toBe(0);
  expect(plain.stdout).toBe(`${sendQuestion("your model provider")} yes (--yes)\n${DOCKER_LINE}\n` +
    "✓ Consent recorded: code may go to your model provider");
  const text = readFileSync(settingsPath(repo), "utf8");
  expect(text.split("\n")[0]).toMatch(/^consent_at = "/);
  expect(text.split("\n")[1]).toMatch(STAMP);
  expect(without(text, "consent_at")).toBe(noConsent);
  expect(loadSettings(repo).consentAt).toBeTruthy();
});

test("arnx consent: declined writes nothing; with no config it says to run init", async () => {
  const repo = gitRepo(tmp());
  expect(await new Cli({ cwd: repo }).run("consent", "--cloud", "--yes")).toBe(3);
  await new Cli({ cwd: repo }).run("init");
  const before = readFileSync(settingsPath(repo), "utf8");
  const cli = new Cli({ cwd: repo, ask: async () => "n" });
  expect(await cli.run("consent", "--cloud")).toBe(3);
  expect(cli.stderr).toContain("consent declined; nothing written");
  expect(readFileSync(settingsPath(repo), "utf8")).toBe(before);
});

test("doctor checks the cloud consent when arnx models is in effect, and only then", async () => {
  const c = cloud = fakeCloud({ balance: 1_000_000 });
  const home = tmp();
  writeCredentials({ HOME: home }, { url: c.url, token: TOKEN });
  const env = { HOME: home, ARNX_CLOUD_URL: c.url, ANTHROPIC_API_KEY: "a" };
  const { repo } = await flipped(env);
  const cli = new Cli({ cwd: repo, env });
  expect(await cli.run("doctor")).toBe(3);
  expect(cli.stdout).toContain("✓ Models: arnx cloud\n✓ Login: logged in to");
  expect(cli.stdout).toContain("✓ Docker: running\n· Consent: pending (arnx cloud)\n");
  cli.out = [];
  await cli.run("doctor", "--local");
  expect(cli.stdout).not.toContain("(arnx cloud)");
  expect(cli.stdout).toContain("✓ Keys: 1 required key present");
  await cli.run("consent", "--cloud", "--yes");
  cli.out = [];
  await cli.run("doctor");
  expect(cli.stdout).toMatch(/^✓ Consent: given \d{4}-\d\d-\d\d \(arnx cloud\)$/m);
});

test("next with arnx models and no cloud consent: no consent step (the first send asks it)", async () => {
  const c = cloud = fakeCloud({ balance: 1_000_000 });
  const home = tmp();
  writeCredentials({ HOME: home }, { url: c.url, token: TOKEN });
  const env = { HOME: home, ARNX_CLOUD_URL: c.url };
  const { repo } = await flipped(env);
  const cli = new Cli({ cwd: repo, env });
  await cli.run("next");
  expect(cli.stdout).not.toContain("arnx consent");
  expect(cli.stdout).toContain("arnx setup");
});

test("arnx cloud on asks the cloud consent once and turns [cloud] models on; off turns it off; nothing else changes",
  async () => {
  const repo = gitRepo(tmp());
  await new Cli({ cwd: repo }).run("init");
  const path = settingsPath(repo);
  const before = readFileSync(path, "utf8");
  const declined = new Cli({ cwd: repo, ask: async () => "n" });
  expect(await declined.run("cloud", "on")).toBe(3);
  expect(readFileSync(path, "utf8")).toBe(before);
  const cli = new Cli({ cwd: repo, ask: async () => "y" });
  expect(await cli.run("cloud", "on")).toBe(0);
  // A new repository: setup calls models, so the login comes first.
  expect(cli.stdout).toBe(`${DOCKER_LINE}\n✓ arnx cloud on: its models run the reviews, not your keys\n` +
    "Next: arnx login\nThen: arnx setup");
  const on = loadSettings(repo);
  expect([on.cloud?.models, Boolean(on.cloudConsentAt)]).toEqual([true, true]);
  expect(readFileSync(path, "utf8")).toMatch(/^models = true +# true: arnx models/m);
  // Asked once: a second `on` asks nothing.
  const again = new Cli({ cwd: repo, ask: async () => { throw new Error("asked again"); } });
  expect(await again.run("cloud", "on")).toBe(0);
  expect(again.stdout).toBe("arnx cloud is already on.\nNext: arnx login\nThen: arnx setup");
  const off = new Cli({ cwd: repo });
  expect(await off.run("cloud", "off")).toBe(0);
  expect(off.stdout).toBe("✓ arnx cloud off: your own model providers run the reviews\n" +
    "Missing ANTHROPIC_API_KEY: export it (https://console.anthropic.com/settings/keys).\nNext: arnx doctor");
  // With the keys set: the flow's next step.
  const keyed = new Cli({ cwd: repo, env: { ANTHROPIC_API_KEY: "a" } });
  expect(await keyed.run("cloud", "off")).toBe(0);
  expect(keyed.stdout).toBe("✓ arnx cloud off: your own model providers run the reviews\nNext: arnx setup");
  expect(loadSettings(repo).cloud?.models).toBe(false);
  expect(await off.run("cloud", "maybe")).toBe(2);
});

/** A repository set up, approved and with its review accepted: the flow's next step calls no model. */
function accepted(): string {
  const repo = gitRepo(tmp());
  mkdirSync(join(repo, "svc"));
  writeFileSync(join(repo, "svc/a.py"), "X = 1\n");
  commit(repo, "a");
  writeSettings(repo, { ...defaultSettings(), consentAt: "2026-10-20T00:00:00Z" });
  const yaml = "version: 1\nprojects:\n  svc:\n    root: svc\n    image: python:3.12-slim\n    test_command: pytest {targets}\n";
  writeFileSync(reviewConfigPath(repo), stampFile(parseReviewFile(yaml), "Dev", "2026-10-20"));
  const rdir = join(repo, ".arnx", "reviews", "20261020-a1b2c3");
  save(sampleReview({ id: "20261020-a1b2c3" }), rdir, "d");
  writeFileSync(join(rdir, "accepted.json"), "{}\n");
  return repo;
}

test("cloud on in a set-up repository: the flow's next step first, the login said for the next review", async () => {
  const repo = accepted();
  const home = tmp();
  const cli = new Cli({ cwd: repo, env: { HOME: home, ARNX_CLOUD_URL: "http://127.0.0.1:9" } });
  expect(await cli.run("cloud", "on", "--yes")).toBe(0);
  expect(cli.stdout).toBe(`${sendQuestion("arnx cloud")} yes (--yes)\n${DOCKER_LINE}\n` +
    "✓ arnx cloud on: its models run the reviews, not your keys\nNext: fix the bugs\nThen: arnx check\n" +
    "arnx login is needed before the next review.");
  // Logged in: just the flow's next step.
  writeCredentials({ HOME: home }, { url: "http://127.0.0.1:9", token: TOKEN });
  const again = new Cli({ cwd: repo, env: { HOME: home, ARNX_CLOUD_URL: "http://127.0.0.1:9" } });
  expect(await again.run("cloud", "on")).toBe(0);
  expect(again.stdout).toBe("arnx cloud is already on.\nNext: fix the bugs\nThen: arnx check");
});

test("cloud on, logged in, in a new repository: the flow's next step, no login", async () => {
  const repo = gitRepo(tmp());
  const home = tmp();
  const env = { HOME: home, ARNX_CLOUD_URL: "http://127.0.0.1:9" };
  await new Cli({ cwd: repo, env }).run("init");
  writeCredentials({ HOME: home }, { url: "http://127.0.0.1:9", token: TOKEN });
  const cli = new Cli({ cwd: repo, env });
  expect(await cli.run("cloud", "on", "--yes")).toBe(0);
  expect(cli.stdout).toEndWith("✓ arnx cloud on: its models run the reviews, not your keys\nNext: arnx setup");
});
