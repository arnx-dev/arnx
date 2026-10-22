// arnx cloud's account side in the CLI: the [cloud] table, the device login (RFC 8628) and its credentials file, logout,
// credits, and what doctor and next check when arnx models stands in for the user's keys.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sendQuestion } from "../src/cli";
import { CloudClient, CloudNotOpen, CloudUnavailable, credentialsPath, deviceLogin, type Fetch, NOT_OPEN, readCredentials,
  UNAVAILABLE, UPDATE, writeCredentials } from "../src/cloud";
import { SetupRequired } from "../src/errors";
import { CLOUD_URL, cloudModels, cloudUrl, defaultSettings, loadSettings, settingsPath, writeSettings } from "../src/settings";
import { VERSION } from "../src/version";
import { Cli } from "./helpers/cli";
import { type FakeCloud, fakeCloud, TOKEN } from "./helpers/cloudfake";
import { gitRepo } from "./helpers/gitutil";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
let cloud: FakeCloud | null = null;
afterEach(() => {
  cloud?.stop();
  cloud = null;
});
const start = (...a: Parameters<typeof fakeCloud>) => (cloud = fakeCloud(...a));
const noWait = async () => {};

test("[cloud] is read, checked and always written: models off unless turned on", () => {
  const repo = gitRepo(tmp());
  const s = { ...defaultSettings(), consentAt: "2026-10-20T00:00:00Z" };
  writeSettings(repo, s);
  expect(readFileSync(settingsPath(repo), "utf8")).toContain("\n[cloud]\nmodels = false   ");
  expect(loadSettings(repo).cloud).toEqual({ models: false, tests: false, effort: "medium" });
  // Settings with no [cloud] at all are written the same way.
  writeSettings(repo, { ...s, cloud: undefined });
  expect(loadSettings(repo).cloud).toEqual({ models: false, tests: false, effort: "medium" });
  // A file written before the table was: it loads as it did, models off.
  writeFileSync(settingsPath(repo), 'consent_at = "x"\n[models]\n');
  expect(loadSettings(repo).cloud).toBeUndefined();
  expect(cloudModels(loadSettings(repo))).toBe(false);
  writeSettings(repo, { ...s, cloud: { models: true, tests: false, effort: "high", url: "http://localhost:1" } });
  const text = readFileSync(settingsPath(repo), "utf8");
  expect(text).toContain("[cloud]\nmodels = true");
  expect(loadSettings(repo).cloud).toEqual({ models: true, tests: false, effort: "high", url: "http://localhost:1" });
  const write = (body: string) => writeFileSync(settingsPath(repo), `consent_at = "x"\n[cloud]\n${body}\n`);
  write("models = true");
  expect(loadSettings(repo).cloud).toEqual({ models: true, tests: false, effort: "medium" });
  write("tests = true");
  expect(() => loadSettings(repo)).toThrow(/arnx tests is not available yet/);
  write('effort = "max"');
  expect(() => loadSettings(repo)).toThrow(/cloud.effort/);
  write('models = "yes"');
  expect(() => loadSettings(repo)).toThrow(/cloud.models: write true or false/);
  write(`url = "${CLOUD_URL}/"`);
  expect(loadSettings(repo).cloud!.url).toBeUndefined(); // the default is not kept
});

test("the API's address: ARNX_CLOUD_URL, else [cloud] url, else api.arnx.dev", () => {
  const s = { ...defaultSettings(), cloud: { models: true, tests: false, effort: "low" as const,
    url: "http://example.test" } };
  expect(cloudUrl(null, {})).toBe("https://api.arnx.dev");
  expect(cloudUrl(s, {})).toBe("http://example.test");
  expect(cloudUrl(s, { ARNX_CLOUD_URL: "http://localhost:9/" })).toBe("http://localhost:9");
});

test("login: pending, slow_down, then the token, kept 0600 in the config directory", async () => {
  const c = start({ polls: ["authorization_pending", "slow_down", "authorization_pending"] });
  const env = { HOME: tmp() };
  const waits: number[] = [];
  const said: string[] = [];
  const r = await deviceLogin(c.url, env, { sleep: async (ms) => { waits.push(ms); }, say: (l) => said.push(l) });
  expect(said).toEqual(["Sign in to arnx cloud", "  1. Open: https://arnx.dev/device", "  2. Enter code: ABCD-1234",
    "  (or open https://arnx.dev/device?code=ABCD-1234 to skip step 2)", "Waiting for the browser... (Ctrl+C cancels)"]);
  // interval 1 s; slow_down adds 5 s from then on.
  expect(waits).toEqual([1000, 1000, 6000, 6000]);
  expect(r.email).toBe("dev@example.com");
  const path = join(tmp(), ".config", "arnx", "credentials.json");
  expect(r.path).toBe(path);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ url: c.url, token: TOKEN });
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(c.seen.filter((x) => x.path === "/v1/auth/token").map((x) => x.body)).toEqual(
    Array(4).fill({ device_code: "dev-code" }));
});

test("login: XDG_CONFIG_HOME wins; an older file is made 0600 again", () => {
  const env = { HOME: tmp(), XDG_CONFIG_HOME: join(tmp(), "xdg") };
  expect(credentialsPath(env)).toBe(join(tmp(), "xdg", "arnx", "credentials.json"));
  mkdirSync(join(tmp(), "xdg", "arnx"), { recursive: true });
  writeFileSync(credentialsPath(env)!, "{}", { mode: 0o644 });
  writeCredentials(env, { url: "u", token: "t" });
  expect(statSync(credentialsPath(env)!).mode & 0o777).toBe(0o600);
  expect(readCredentials(env)).toEqual({ url: "u", token: "t" });
  expect(credentialsPath({})).toBeNull();
  // A directory others can write to is made this user's only; one arnx makes is 0700.
  chmodSync(join(tmp(), "xdg", "arnx"), 0o777);
  writeCredentials(env, { url: "u", token: "t2" });
  expect(statSync(join(tmp(), "xdg", "arnx")).mode & 0o777).toBe(0o700);
  expect(statSync(credentialsPath(env)!).mode & 0o777).toBe(0o600);
  expect(existsSync(`${credentialsPath(env)!}.tmp`)).toBe(false);
  const fresh = { HOME: join(tmp(), "fresh") };
  writeCredentials(fresh, { url: "u", token: "t" });
  expect(statSync(join(tmp(), "fresh", ".config", "arnx")).mode & 0o777).toBe(0o700);
});

test("login: an expired code or a refusal stops with a message and saves nothing", async () => {
  const env = { HOME: tmp() };
  let c = start({ polls: ["expired_token"] });
  await expect(deviceLogin(c.url, env, { sleep: noWait, say: () => {} })).rejects.toThrow(
    "the code expired; run arnx login again");
  c.stop();
  c = start({ polls: ["access_denied"] });
  await expect(deviceLogin(c.url, env, { sleep: noWait, say: () => {} })).rejects.toThrow(/refused/);
  c.stop();
  // The code's own lifetime (the server's expires_in) runs out while the user is still away: no poll after it.
  c.stop();
  c = start({ polls: Array(20).fill("authorization_pending"), device: { expires_in: 3, interval: 1 } });
  let clock = 0;
  const waits: number[] = [];
  await expect(deviceLogin(c.url, env, { sleep: async (ms) => { waits.push(ms); clock += ms; }, now: () => clock,
    say: () => {} })).rejects.toThrow("the code expired; run arnx login again");
  expect(waits).toEqual([1000, 1000, 1000]);
  expect(c.seen.filter((x) => x.path === "/v1/auth/token")).toHaveLength(2);
  expect(existsSync(credentialsPath(env)!)).toBe(false);
  // Through the CLI: one line, exit 2.
  c.stop();
  c = start({ polls: ["expired_token"] });
  const cli = new Cli({ cwd: tmp(), env: { HOME: tmp(), ARNX_CLOUD_URL: c.url }, sleep: noWait });
  expect(await cli.run("login")).toBe(2);
  expect(cli.err).toEqual(["arnx: the code expired; run arnx login again"]);
});

test("login without verification_uri_complete: no skip line; no email: logged in to arnx cloud", async () => {
  const c = start({ device: { verification_uri_complete: undefined } });
  c.script.fail = { "POST /v1/auth/token": [{ status: 200, body: { access_token: TOKEN, token_type: "bearer",
    account_id: "acct_test0001" } }] };
  const home = tmp();
  const cli = new Cli({ cwd: home, env: { HOME: home, ARNX_CLOUD_URL: c.url }, sleep: noWait });
  expect(await cli.run("login")).toBe(0);
  expect(cli.stdout).toBe("Sign in to arnx cloud\n  1. Open: https://arnx.dev/device\n  2. Enter code: ABCD-1234\n" +
    "Waiting for the browser... (Ctrl+C cancels)\n✓ Logged in to arnx cloud");
});

test("Ctrl+C while login waits: exit 130, one line, no stack trace, nothing saved", async () => {
  const c = start({ polls: Array(100).fill("authorization_pending") });
  const home = tmp();
  const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "main.ts"), "login"], {
    env: { HOME: home, PATH: process.env.PATH ?? "", ARNX_CLOUD_URL: c.url }, stdout: "pipe", stderr: "pipe" });
  const reader = proc.stdout.getReader();
  let out = "";
  while (!out.includes("Waiting for the browser")) {
    const { value, done } = await reader.read();
    if (done) break;
    out += new TextDecoder().decode(value);
  }
  proc.kill("SIGINT");
  expect(await proc.exited).toBe(130);
  expect(await new Response(proc.stderr).text()).toBe("arnx: interrupted\n");
  expect(existsSync(credentialsPath({ HOME: home })!)).toBe(false);
}, 20_000);

test("arnx login, credits and logout", async () => {
  const c = start({ balance: 4_250_000 });
  const home = tmp();
  const cli = new Cli({ cwd: home, env: { HOME: home, ARNX_CLOUD_URL: c.url }, sleep: noWait });
  expect(await cli.run("credits")).toBe(3); // not logged in yet
  expect(cli.err).toEqual([`arnx: not logged in to arnx cloud (${c.url}). Next: arnx login`]);
  expect(await cli.run("login")).toBe(0);
  expect(cli.stdout).toBe("Sign in to arnx cloud\n  1. Open: https://arnx.dev/device\n  2. Enter code: ABCD-1234\n" +
    "  (or open https://arnx.dev/device?code=ABCD-1234 to skip step 2)\nWaiting for the browser... (Ctrl+C cancels)\n" +
    "✓ Logged in as dev@example.com");
  cli.out = [];
  expect(await cli.run("credits")).toBe(0);
  expect(cli.stdout).toBe("arnx cloud · dev@example.com\n  Available: $4.25\nTop up: https://arnx.dev/credits");
  expect(c.seen.at(-1)!.headers.authorization).toBe(`Bearer ${TOKEN}`);
  cli.out = [];
  expect(await cli.run("logout")).toBe(0);
  expect(cli.stdout).toBe("✓ Logged out of arnx cloud");
  expect(existsSync(join(home, ".config", "arnx", "credentials.json"))).toBe(false);
  cli.out = [];
  expect(await cli.run("logout")).toBe(0);
  expect(cli.stdout).toBe("Not logged in to arnx cloud; nothing to do.");
});

test("credits: what reviews in progress reserve, apart; a debt pauses new reviews", async () => {
  // The contract's balance_micro_usd already leaves the holds out: it is what is available.
  let c = start({ balance: 4_250_000, held: 400_000 });
  const home = tmp();
  writeCredentials({ HOME: home }, { url: c.url, token: TOKEN });
  let cli = new Cli({ cwd: home, env: { HOME: home, ARNX_CLOUD_URL: c.url } });
  expect(await cli.run("credits")).toBe(0);
  expect(cli.stdout).toBe("arnx cloud · dev@example.com\n  Available: $4.25\n  Reserved:  $0.40 (reviews in progress)\n" +
    "Top up: https://arnx.dev/credits");
  c.stop();
  c = start({ balance: -250_000 });
  writeCredentials({ HOME: home }, { url: c.url, token: TOKEN });
  cli = new Cli({ cwd: home, env: { HOME: home, ARNX_CLOUD_URL: c.url } });
  expect(await cli.run("credits")).toBe(0);
  expect(cli.stdout).toBe("✗ Outstanding balance: $0.25 (a review's overage)\n" +
    "New arnx cloud reviews are paused until you top up.\nTop up: https://arnx.dev/credits");
});

test("init --cloud: config gets [cloud]; next is login, then setup", async () => {
  const c = start();
  const repo = gitRepo(tmp());
  const env = { HOME: tmp(), ARNX_CLOUD_URL: c.url };
  const cli = new Cli({ cwd: repo, env });
  expect(await cli.run("init", "--cloud")).toBe(0);
  expect(cli.stdout).not.toContain(sendQuestion("arnx cloud"));
  expect(cli.stdout).not.toContain("API_KEY");
  expect(cli.stdout).toStartWith("✓ arnx initialized for arnx cloud\n");
  expect(cli.stdout).toMatch(/\nNext: arnx login\nThen: arnx setup\nOptional: arnx skill install \(coding agents\)$/);
  expect(loadSettings(repo).cloud).toEqual({ models: true, tests: false, effort: "medium" });
  expect(c.seen).toHaveLength(0);
});

test("doctor with arnx models: login and credits instead of keys", async () => {
  const c = start({ balance: 0 });
  const repo = gitRepo(tmp());
  const home = tmp();
  const env = { HOME: home, ARNX_CLOUD_URL: c.url };
  const cli = new Cli({ cwd: repo, env });
  await cli.run("init", "--cloud");
  expect(await cli.run("doctor")).toBe(3);
  expect(cli.stdout).not.toContain("Keys:");
  expect(cli.stdout).toContain(`✗ Login: not logged in to ${c.url}; run \`arnx login\``);
  writeCredentials({ HOME: home }, { url: c.url, token: TOKEN });
  cli.out = [];
  await cli.run("doctor");
  expect(cli.stdout).toContain(`✓ Login: logged in to ${c.url}`);
  expect(cli.stdout).toContain("✗ Credits: $0.00 available; top up at https://arnx.dev/credits");
});

test("doctor names the unreachable part and whether the user's own keys would do", async () => {
  const c = start();
  const repo = gitRepo(tmp());
  const home = tmp();
  const env = { HOME: home, ARNX_CLOUD_URL: c.url, ANTHROPIC_API_KEY: "a" };
  await new Cli({ cwd: repo, env }).run("init", "--cloud");
  writeCredentials({ HOME: home }, { url: c.url, token: TOKEN });
  c.script.fail = { "GET /v1/account": Array(3).fill({ status: 503, body: { code: "unavailable",
    message: "down for maintenance", component: "api" } }) };
  const cli = new Cli({ cwd: repo, env, sleep: noWait });
  expect(await cli.run("doctor")).toBe(3);
  expect(cli.stdout).toContain(`✗ Credits: arnx cloud unavailable: its api at ${c.url} is down (down for ` +
    "maintenance). Try again later. To use your own keys: arnx cloud off\n");
});

test("next with arnx models: log in first, then top up", async () => {
  const c = start({ balance: -1 });
  const repo = gitRepo(tmp());
  const home = tmp();
  const env = { HOME: home, ARNX_CLOUD_URL: c.url };
  const cli = new Cli({ cwd: repo, env });
  await cli.run("init", "--cloud");
  cli.out = [];
  await cli.run("next");
  expect(cli.stdout).toContain("arnx login");
  expect(cli.stdout).toContain("Next:  arnx login\nThen:  arnx setup");
  writeCredentials({ HOME: home }, { url: c.url, token: TOKEN });
  cli.out = [];
  await cli.run("next");
  expect(cli.stdout).toContain("arnx credits");
  expect(cli.stdout).toContain("-$0.00");
});

test("the client: 402 is a top-up (exit 3); 503 and a dead address name the part (exit 2); 503 is retried", async () => {
  const c = start({ fail: {
    "GET /v1/account": [{ status: 402, body: { code: "insufficient_credits", message: "Your balance is too low.",
      balance_micro_usd: 120_000, needed_micro_usd: 380_000, topup_url: "https://arnx.dev/credits" } },
    { status: 503, body: { code: "unavailable", message: "busy", component: "brain" } }],
  } });
  const client = new CloudClient(c.url, { token: TOKEN, delays: [0], hint: () => "To use your own keys: arnx cloud off" });
  const e402 = await client.call("GET", "/v1/account").catch((e: unknown) => e);
  expect(e402).toBeInstanceOf(SetupRequired);
  expect((e402 as Error).message).toContain("Balance $0.12; $0.38 more lets this start. Top up at https://arnx.dev/credits");
  // One 503, then the account: the retry got through.
  expect(await client.call<{ balance_micro_usd: number }>("GET", "/v1/account")).toMatchObject({ balance_micro_usd: 5_000_000 });
  const dead = new CloudClient("http://127.0.0.1:9", { token: TOKEN, delays: [0],
    hint: () => "To use your own keys: arnx cloud off" });
  const down = await dead.call("POST", "/v1/reviews", {}).catch((e: unknown) => e) as CloudUnavailable;
  expect(down).toBeInstanceOf(CloudUnavailable);
  expect(down).not.toBeInstanceOf(CloudNotOpen);
  expect([down.exitCode, down.component]).toEqual([2, "brain"]);
  expect(down.message).toBe("arnx cloud unavailable: could not connect to http://127.0.0.1:9. Check your connection " +
    "or try again later.\nTo use your own keys: arnx cloud off");
});

test("an arnx older than arnx cloud accepts: login and reviews stop with how to update (exit 3), not retried", async () => {
  const old = { status: 422, body: { code: "unsupported_cli", min_cli_version: "9.0.0",
    message: `arnx ${VERSION} is older than arnx cloud accepts (9.0.0 or later); update arnx to continue` } };
  const c = start({ fail: { "POST /v1/auth/device": [old], "POST /v1/reviews": [old] } });
  const home = tmp();
  const cli = new Cli({ cwd: home, env: { HOME: home, ARNX_CLOUD_URL: c.url }, sleep: noWait });
  expect(await cli.run("login")).toBe(3);
  expect(cli.err).toEqual([`arnx: arnx cloud needs arnx 9.0.0 or later (this is ${VERSION}). ${UPDATE}`]);
  const client = new CloudClient(c.url, { token: TOKEN, delays: [0] });
  const e = await client.call("POST", "/v1/reviews", {}).catch((x: unknown) => x);
  expect(e).toBeInstanceOf(SetupRequired);
  expect(c.seen.filter((x) => x.path === "/v1/reviews")).toHaveLength(1);
});

// --- no answer vs not open: only arnx cloud's own `not_open` says it is closed ------------------------------------------

/** A fetch as a machine where api.arnx.dev does not resolve, or answers as something that is not arnx cloud. */
const dnsFails: Fetch = async () => { throw new Error("Unable to connect. Is the computer able to access the url?"); };
const answers = (status: number, body: string, type = "text/html"): Fetch => async () =>
  new Response(body, { status, headers: { "content-type": type } });
/** Calls to the default address served by the fake instead: arnx cloud once it answers there. */
const viaFake = (c: FakeCloud): Fetch => (u, init) => fetch(u.replace(CLOUD_URL, c.url), init);
const NOT_OPEN_BODY = JSON.stringify({ code: "not_open", message: "arnx cloud is not open yet" });

test("the default address unreachable: login and credits say arnx cloud is unavailable, no waitlist (exit 2)",
  async () => {
    const home = tmp();
    const cli = new Cli({ cwd: home, env: { HOME: home }, fetch: dnsFails, sleep: noWait });
    expect(await cli.run("login")).toBe(2);
    expect(cli.stdout).toBe("");
    // Outside a repository: nothing about keys.
    expect(cli.err).toEqual(["arnx: arnx cloud unavailable: could not connect to https://api.arnx.dev. Check your " +
      "connection or try again later."]);
    expect(existsSync(credentialsPath({ HOME: home })!)).toBe(false);
    writeCredentials({ HOME: home }, { url: CLOUD_URL, token: TOKEN });
    cli.err = [];
    expect(await cli.run("credits")).toBe(2);
    expect(cli.err).toEqual([`arnx: ${UNAVAILABLE(CLOUD_URL)}`]);
    expect(cli.stderr).not.toContain("waitlist");
  });

test("unavailable in a repository on arnx cloud: the way to the user's own keys only when they are all set", async () => {
  const home = tmp();
  const repo = gitRepo(tmp());
  await new Cli({ cwd: repo, env: { HOME: home } }).run("init", "--cloud");
  writeCredentials({ HOME: home }, { url: CLOUD_URL, token: TOKEN });
  const run = async (env: Record<string, string>) => {
    const cli = new Cli({ cwd: repo, env: { HOME: home, ...env }, fetch: dnsFails, sleep: noWait });
    expect(await cli.run("credits")).toBe(2);
    return cli.err;
  };
  expect(await run({})).toEqual([`arnx: ${UNAVAILABLE(CLOUD_URL)}`]); // ANTHROPIC_API_KEY missing
  expect(await run({ ANTHROPIC_API_KEY: "a" })).toEqual([`arnx: ${UNAVAILABLE(CLOUD_URL)}\nTo use your own keys: ` +
    "arnx cloud off"]);
  // arnx cloud chosen by ARNX_MODELS (the file says your own keys): --local is the way, not `arnx cloud off`.
  await new Cli({ cwd: repo, env: { HOME: home } }).run("cloud", "off");
  expect(await run({ ANTHROPIC_API_KEY: "a", ARNX_MODELS: "cloud" })).toEqual([`arnx: ${UNAVAILABLE(CLOUD_URL)}\n` +
    "To use your own keys for this run: --local"]);
  // The file on your own keys and nothing overriding it: arnx cloud is not what runs the reviews, no hint.
  expect(await run({ ANTHROPIC_API_KEY: "a" })).toEqual([`arnx: ${UNAVAILABLE(CLOUD_URL)}`]);
});

test("no answer: DNS, refused, TLS, and a 404 or 5xx that is not arnx cloud's, on the first call", async () => {
  const tls: Fetch = async () => { throw new Error("self signed certificate"); };
  for (const f of [dnsFails, tls, answers(404, "<html>Not Found</html>"), answers(502, "Bad Gateway"),
    answers(503, "<html>Service Unavailable</html>"), answers(500, ""), answers(200, "<html>parked</html>")]) {
    const e = await new CloudClient(CLOUD_URL, { token: TOKEN, fetch: f, delays: [0], sleep: noWait,
      hint: () => "" }).call("GET", "/v1/account").catch((x: unknown) => x) as CloudUnavailable;
    expect(e).toBeInstanceOf(CloudUnavailable);
    expect(e).not.toBeInstanceOf(CloudNotOpen);
    expect([e.exitCode, e.message]).toEqual([2, UNAVAILABLE(CLOUD_URL)]);
  }
  // arnx cloud's own error answer is arnx cloud answering: what it says, as today.
  const own = await new CloudClient(CLOUD_URL, { token: TOKEN, fetch: answers(500, JSON.stringify({ code: "internal",
    message: "boom", request_id: "r1" }), "application/json") }).call("GET", "/v1/account").catch((x: unknown) => x);
  expect(own).not.toBeInstanceOf(CloudUnavailable);
  expect((own as Error).message).toBe("arnx cloud api failed on its side (request r1): boom");
});

test("arnx cloud's explicit not_open: the waitlist, at any address, not retried (exit 2)", async () => {
  let calls = 0;
  const closed: Fetch = async () => { calls++; return answers(403, NOT_OPEN_BODY, "application/json")("", {}); };
  const e = await new CloudClient(CLOUD_URL, { token: TOKEN, fetch: closed, delays: [0, 0], sleep: noWait })
    .call("GET", "/v1/account").catch((x: unknown) => x) as CloudNotOpen;
  expect(e).toBeInstanceOf(CloudNotOpen);
  expect([e.exitCode, e.message, calls]).toEqual([2, NOT_OPEN, 1]);
  expect(NOT_OPEN).toBe("arnx cloud is not open yet. Your own keys work today (`--local`); join the waitlist at " +
    "https://arnx.dev.");
  // Through the CLI, from the fake at a developer's address: the device start refused.
  const c = start({ fail: { "POST /v1/auth/device": [{ status: 403, body: { code: "not_open",
    message: "arnx cloud is not open yet" } }] } });
  const home = tmp();
  const cli = new Cli({ cwd: home, env: { HOME: home, ARNX_CLOUD_URL: c.url }, sleep: noWait });
  expect(await cli.run("login")).toBe(2);
  expect(cli.err).toEqual([`arnx: ${NOT_OPEN}`]);
  expect(existsSync(credentialsPath({ HOME: home })!)).toBe(false);
});

test("the default address once arnx cloud answers there: login and credits as usual, a later outage unavailable",
  async () => {
    const c = start({ balance: 4_250_000 });
    const home = tmp();
    const cli = new Cli({ cwd: home, env: { HOME: home }, fetch: viaFake(c), sleep: noWait });
    expect(await cli.run("login")).toBe(0);
    expect(cli.stdout).toContain("✓ Logged in as dev@example.com");
    expect(readCredentials({ HOME: home })).toEqual({ url: CLOUD_URL, token: TOKEN });
    cli.out = [];
    expect(await cli.run("credits")).toBe(0);
    expect(cli.stdout).toBe("arnx cloud · dev@example.com\n  Available: $4.25\nTop up: https://arnx.dev/credits");
    let calls = 0;
    const client = new CloudClient(CLOUD_URL, { token: TOKEN, delays: [0], sleep: noWait,
      fetch: (u, init) => (calls++ ? dnsFails(u, init) : viaFake(c)(u, init)) });
    await client.call("GET", "/v1/account");
    const down = await client.call("GET", "/v1/account").catch((x: unknown) => x) as CloudUnavailable;
    expect(down).not.toBeInstanceOf(CloudNotOpen);
    expect(down.message).toBe(UNAVAILABLE(CLOUD_URL));
  });

test("an ARNX_CLOUD_URL that does not answer: unavailable, naming the address (exit 2)", async () => {
  const home = tmp();
  const url = "http://127.0.0.1:9";
  writeCredentials({ HOME: home }, { url, token: TOKEN });
  const cli = new Cli({ cwd: home, env: { HOME: home, ARNX_CLOUD_URL: url }, sleep: noWait });
  expect(await cli.run("credits")).toBe(2);
  expect(cli.err).toEqual([`arnx: ${UNAVAILABLE(url)}`]);
  // A 404 there is the developer's server answering: its error, as today.
  const e = await new CloudClient(url, { fetch: answers(404, "<html>Not Found</html>") }).call("GET", "/v1/account")
    .catch((x: unknown) => x) as Error;
  expect(e).not.toBeInstanceOf(CloudUnavailable);
  expect(e.message).toContain("not JSON");
});

test("unsupported_cli without min_cli_version reads as a sentence: a newer arnx, this version, how to update", async () => {
  const f = async () => new Response(JSON.stringify({ code: "unsupported_cli", message: "too old" }), { status: 422,
    headers: { "content-type": "application/json" } });
  const c = new CloudClient("http://cloud.test", { token: "t", fetch: f as never, delays: [0], sleep: async () => {} });
  const e = await c.call("POST", "/v1/reviews", {}).catch((x: unknown) => x) as Error;
  expect(e.message).toStartWith(`arnx cloud needs a newer arnx (this is ${VERSION}). `);
});
