// Setup goes on where a stand-in or a sandbox copy keeps every real value out: key-shaped text, values given to
// secret-looking names and random-looking runs get stand-ins; a file .arnxignore leaves out that the tests need is in
// the sandbox only while a test runs, and what runs quote of it is taken out; a secret-looking variable may take a
// value arnx generates. Keys here are built from parts.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addToSandbox, SANDBOX_MARK, sandboxDir, stripSandbox, takeSnapshot, withSandboxFiles } from "../src/change";
import { parseReviewConfig, parseReviewFile, sandboxOnlyOf } from "../src/config";
import { DEFAULT_LIMITS, runArgv } from "../src/sandbox";
import { envValue, hasSecretContent, secretPins, standIn, suspects } from "../src/secrets";
import { defaultSettings, loadSettings, writeSettings } from "../src/settings";
import { approvalWarnings } from "../src/setupview";
import { AWS_KEY, AWS_KEY_2, PRIVATE_KEY, PRIVATE_KEY_BLOCK, SLACK_TOKEN } from "./helpers/fakekeys";
import { commit, gitRepo } from "./helpers/gitutil";
import { useTmp } from "./helpers/tmp";
import { GOOD, PROJECTS } from "./helpers/yaml";

const tmp = useTmp();
const AWS_SECRET = "wJalrXUtnFEMI/K7MDENG/" + "bPxRfiCYEXAMPLEKEY";
const SK = "sk-" + "Ab3dE".repeat(8);

/** Every file under `dir`, as text. */
function allText(dir: string): string {
  if (!existsSync(dir)) return "";
  return readdirSync(dir, { recursive: true }).map((p) => join(dir, String(p))).filter((p) => statSync(p).isFile())
    .map((p) => readFileSync(p, "utf8")).join("\n");
}

/** A key's shape: its prefix, then 0, A or a for each digit, upper- or lower-case letter. */
const shape = (key: string) => {
  const prefix = /^(AKIA|xoxb-|sk-)/.exec(key)![0];
  return prefix + key.slice(prefix.length).replace(/[0-9]/g, "0").replace(/[A-Z]/g, "A").replace(/[a-z]/g, "a");
};

test("a stand-in keeps each key's prefix, length and kinds of characters, and none of the key", () => {
  const text = `A = '${AWS_KEY}'\nS = '${SLACK_TOKEN}'\nO = '${SK}'\n`;
  const r = standIn(text, [])!;
  expect(r.count).toBe(3);
  const [a, s, o] = r.text.split("\n").map((l) => l.slice(5, -1));
  for (const [fake, real] of [[a, AWS_KEY], [s, SLACK_TOKEN], [o, SK]] as const) {
    expect(fake).not.toBe(real);
    expect(shape(fake!)).toBe(shape(real));
    expect(hasSecretContent(fake!)).toBe(true); // a format check in a test still passes
  }
});

test("the same key gets the same stand-in, in one file, in two, and on every run", () => {
  const [first, again] = standIn(`X = '${AWS_KEY}'\nassert X == '${AWS_KEY}'\n`, [])!.text.match(/AKIA\w+/g)!;
  expect(first).toBe(again!);
  expect(standIn(`Y = "${AWS_KEY}"`, [])!.text).toBe(`Y = "${first}"`);
  expect(standIn(`Y = "${AWS_KEY_2}"`, [])!.text).not.toBe(`Y = "${first}"`);
});

test("a run like a key's body beside a key gets a stand-in too; a long name in code does not", () => {
  const name = "handlesTheCaseWhereTheUserHasNoAccountYet";
  const r = standIn(`id = '${AWS_KEY}'\nsecret = '${AWS_SECRET}'\ndef ${name}(): pass\n`, [])!;
  expect(r.count).toBe(2);
  expect(r.text).not.toContain(AWS_KEY);
  expect(r.text).not.toContain(AWS_SECRET);
  expect(r.text).toContain(name);
  expect(r.text.split("\n")[1]!.length).toBe(`secret = '${AWS_SECRET}'`.length);
});

test("an allowed (pinned) key stays as it is; only the others get stand-ins", () => {
  const text = `A = '${AWS_KEY}'\nB = '${SK}'\n`;
  const r = standIn(text, secretPins(`'${AWS_KEY}'`))!;
  expect(r.text).toContain(AWS_KEY);
  expect(r.text).not.toContain(SK);
});

test("a private key with a body gets no stand-in; a header with no body anywhere is a placeholder, kept", () => {
  expect(standIn(`K = """${PRIVATE_KEY_BLOCK}"""\n`, [])).toBeNull();
  // A body elsewhere in the file may be the key's.
  expect(standIn(`H = "${PRIVATE_KEY}"\nB = "${AWS_SECRET}"\n`, [])).toBeNull();
  const hint = `placeholder = "${PRIVATE_KEY}\\n...\\n"\nT = '${AWS_KEY}'\n`;
  const r = standIn(hint, [])!;
  expect(r.text).toContain(PRIVATE_KEY);
  expect(r.text).not.toContain(AWS_KEY);
});

test("a snapshot keeps a file with stand-ins and says so; the real key reaches neither the snapshot nor its sandbox " +
  "files", () => {
  const repo = gitRepo(tmp());
  mkdirSync(join(repo, "tests"), { recursive: true });
  writeFileSync(join(repo, "tests/test_mask.py"), `TOKEN = '${SLACK_TOKEN}'\nAWS = '${AWS_KEY}'\n`);
  writeFileSync(join(repo, "key.py"), `K = """${PRIVATE_KEY_BLOCK}"""\n`);
  writeFileSync(join(repo, "rates.csv"), `fee,${AWS_KEY}\n`);
  writeFileSync(join(repo, ".arnxignore"), "*.csv\n");
  commit(repo, "fixtures");
  const snap = join(tmp(), "snap");
  const r = takeSnapshot(repo, null, snap, [], { sandbox: ["rates.csv"] });
  expect(r.standIns).toEqual(["rates.csv", "tests/test_mask.py"]);
  expect(r.withheld.map((w) => w.path)).toEqual(["key.py"]);
  expect(r.sandboxed).toEqual(["rates.csv"]);
  expect(existsSync(join(snap, "rates.csv"))).toBe(false);
  for (const text of [allText(snap), allText(sandboxDir(snap))]) {
    for (const real of [SLACK_TOKEN, AWS_KEY, PRIVATE_KEY]) expect(text).not.toContain(real);
  }
  expect(readFileSync(join(sandboxDir(snap), "rates.csv"), "utf8")).toMatch(/^fee,AKIA[0-9A-Z]{16}\n$/);
  // The same snapshot of a commit.
  const head = takeSnapshot(repo, "HEAD", join(tmp(), "head"), [], { sandbox: ["rates.csv"] });
  expect([head.standIns, head.sandboxed]).toEqual([r.standIns, r.sandboxed]);
  expect(readFileSync(join(tmp(), "head/tests/test_mask.py"), "utf8"))
    .toBe(readFileSync(join(snap, "tests/test_mask.py"), "utf8"));
});

test("stand_ins = false leaves such files out, as before", () => {
  const repo = gitRepo(tmp());
  writeFileSync(join(repo, "a.py"), `T = '${SLACK_TOKEN}'\n`);
  commit(repo, "a");
  writeSettings(repo, { ...defaultSettings(), standIns: false });
  expect(loadSettings(repo).standIns).toBe(false);
  expect(readFileSync(join(repo, ".arnx/config.toml"), "utf8")).toContain("\nstand_ins = false ");
  const r = takeSnapshot(repo, null, join(tmp(), "snap"));
  expect([r.withheld.map((w) => w.path), r.standIns]).toEqual([["a.py"], []]);
  expect(defaultSettings().standIns).toBe(true);
});

test("a file .arnxignore leaves out moves beside the snapshot, also from a folder it leaves out, and only when named",
  () => {
    const repo = gitRepo(tmp());
    mkdirSync(join(repo, "i18n"), { recursive: true });
    writeFileSync(join(repo, "i18n/ar.json"), "{}\n");
    writeFileSync(join(repo, "i18n/fr.json"), "{}\n");
    writeFileSync(join(repo, "dump.csv"), "a\n");
    writeFileSync(join(repo, ".arnxignore"), "i18n/\n*.csv\n");
    commit(repo, "data");
    const snap = join(tmp(), "snap");
    const r = takeSnapshot(repo, null, snap, [], { sandbox: ["i18n/ar.json"] });
    expect(r.sandboxed).toEqual(["i18n/ar.json"]);
    expect(existsSync(join(snap, "i18n"))).toBe(false);
    expect(readdirSync(sandboxDir(snap), { recursive: true }).map(String).sort()).toEqual(["i18n", "i18n/ar.json"]);
    expect(existsSync(join(snap, "dump.csv"))).toBe(false);
  });

test("sandbox-only files are in the snapshot only while a run runs, then gone with the folders made for them", () => {
  const repo = gitRepo(tmp());
  mkdirSync(join(repo, "i18n"), { recursive: true });
  writeFileSync(join(repo, "i18n/ar.json"), "{\"a\": 1}\n");
  writeFileSync(join(repo, ".arnxignore"), "i18n/\n");
  commit(repo, "data");
  const snap = join(tmp(), "snap");
  takeSnapshot(repo, null, snap, [], { sandbox: ["i18n/ar.json"] });
  const during: string[] = [];
  const runner = withSandboxFiles({ run: () => {
    during.push(readFileSync(join(snap, "i18n/ar.json"), "utf8"));
    return { exitCode: 0, output: "", timedOut: false, seconds: 0 };
  } }, snap);
  runner.run("pytest", 10);
  runner.run("pytest", 10);
  expect(during).toEqual(["{\"a\": 1}\n", "{\"a\": 1}\n"]);
  expect(existsSync(join(snap, "i18n"))).toBe(false);
  // A run that throws takes them out too.
  const failing = withSandboxFiles({ run: () => {
    throw new Error("docker went away");
  } }, snap);
  expect(() => failing.run("pytest", 10)).toThrow("docker went away");
  expect(existsSync(join(snap, "i18n"))).toBe(false);
});

test("setup's copy of a needed file is scrubbed like the snapshot: secret files never, keys with stand-ins", () => {
  const repo = gitRepo(tmp());
  writeFileSync(join(repo, "rates.csv"), `fee,${AWS_KEY}\n`);
  writeFileSync(join(repo, "big.csv"), `k,${PRIVATE_KEY_BLOCK.replaceAll("\n", " ")}\n`);
  writeFileSync(join(repo, ".env"), "A=1\n");
  const snap = join(tmp(), "snap");
  mkdirSync(snap);
  const r = addToSandbox(repo, snap, ["rates.csv", "big.csv", ".env", "missing.csv"]);
  expect([r.sandboxed, r.standIns, r.withheld.map((w) => w.path)]).toEqual([["rates.csv"], ["rates.csv"],
    ["big.csv"]]);
  expect(allText(sandboxDir(snap))).not.toContain(AWS_KEY);
  expect(existsSync(join(sandboxDir(snap), ".env"))).toBe(false);
});

test("review.yaml's sandbox_only: paths inside the repository, named in Worth a look", () => {
  const f = parseReviewFile(`${PROJECTS}sandbox_only: [i18n/ar.json]\n`);
  expect(sandboxOnlyOf(f.raw)).toEqual(["i18n/ar.json"]);
  expect(approvalWarnings(f).at(-1)).toBe("i18n/ar.json: left out by .arnxignore, but the tests need it; copied " +
    "into the sandbox, never sent to the model (sandbox_only in review.yaml)");
  expect(() => parseReviewFile(`${PROJECTS}sandbox_only: [../x]\n`)).toThrow("sandbox_only: must stay inside");
  expect(() => parseReviewFile(`${PROJECTS}sandbox_only: x\n`)).toThrow("sandbox_only: must be a list");
});

test("a secret-looking variable may take a generated value; a literal one is still refused", () => {
  const generated = GOOD.replace("DATABASE_URL:", "SECRET_KEY: arnx:generated\n  FERNET_KEY: arnx:generated:base64\n" +
    "  DATABASE_URL:");
  expect(parseReviewConfig(generated).env.SECRET_KEY).toBe("arnx:generated");
  expect(() => parseReviewConfig(GOOD.replace("DATABASE_URL:", "SECRET_KEY: s3cr3t\n  DATABASE_URL:")))
    .toThrow("write arnx:generated");
  expect(() => parseReviewConfig(GOOD.replace("DATABASE_URL:", "SECRET_KEY: x-arnx:generated\n  DATABASE_URL:")))
    .toThrow("env.SECRET_KEY");
});

test("a run gets the generated values: 64 hex digits, or 32 bytes of URL-safe base64; others as written", () => {
  expect(envValue("arnx:generated")).toMatch(/^[0-9a-f]{64}$/);
  expect(Buffer.from(envValue("arnx:generated:base64"), "base64url")).toHaveLength(32);
  expect(envValue("arnx:generated:base64")).toMatch(/^[A-Za-z0-9_-]{43}=$/);
  expect(envValue("arnx:generated")).toBe(envValue("arnx:generated"));
  expect(envValue("plain")).toBe("plain");
  const argv = runArgv({ image: "img", name: "n", network: "none", snapshot: tmp(), workdir: ".",
    env: { SECRET_KEY: "arnx:generated", MODE: "test" }, command: "pytest", limits: DEFAULT_LIMITS, user: "1:1",
    runEnv: [] });
  expect(argv).toContain(`SECRET_KEY=${envValue("arnx:generated")}`);
  expect(argv).toContain("MODE=test");
});

// The wider rule: what a name marks as secret, and random-looking runs, get stand-ins too; hashes and ids do not.
const HEX64 = "9f86d081884c7d659a2feaa0c55ad015" + "a3bf4f1b2b0b822cd15d6c15b0f00a08";

test("a literal given to a secret-looking name gets a stand-in, in code and in config files", () => {
  const files: [string, string][] = [
    ["settings.py", `SECRET_KEY = "${HEX64}"\n`],
    ["client.ts", `new Client({ apiKey: "Zk3pQ9vLm2Xw7Rt5" })\n`],
    ["call.py", `connect(password="Tr0ub4dor&3x")\n`],
    ["conf.json", `{"client_secret": "a1B2c3D4e5F6g7H8"}\n`],
    ["app.yaml", "db:\n  password: Hx7kq2Lmz9Pw\n"],
    ["env.py", `os.environ.setdefault("STRIPE_TOKEN", "whsec_9aZ3kQ7mP2xL")\n`],
    ["api.py", `headers = {"Authorization": "Bearer 4fG7hJ2kL9mN3pQ5"}\n`],
  ];
  for (const [path, text] of files) {
    const got = suspects(path, text, []);
    expect(`${path}: ${got.length}`).toBe(`${path}: 1`);
  }
  // A token's own prefix stays; hex stays hex.
  const token = standIn(`STRIPE_TOKEN = "whsec_9aZ3kQ7mP2xL"\n`, [])!.text;
  expect(token).toMatch(/^STRIPE_TOKEN = "whsec_[0-9a-zA-Z]{12}"\n$/);
  expect(token).not.toContain("9aZ3kQ7mP2xL");
  expect(standIn(`SECRET_KEY = "${HEX64}"\n`, [])!.text).toMatch(/^SECRET_KEY = "[0-9a-f]{64}"\n$/);
  const uuid = standIn(`api_key = "123e4567-e89b-12d3-a456-426614174000"\n`, [])!.text;
  expect(uuid).toMatch(/^api_key = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"\n$/);
});

test("hashes, commit ids, UUIDs, names and words are left as they are", () => {
  const kept = [
    `assert sha256(b"abc").hexdigest() == "${HEX64}"\n`, // unnamed hex: a hash a test compares
    `token_hash = "${HEX64}"\n`, // a hash, though the name holds token
    `COMMIT = "${HEX64.slice(0, 40)}"\n`,
    `id = "123e4567-e89b-12d3-a456-426614174000"\n`,
    `sort_key = "created_at"\nprimary_key = "user_id"\n`,
    `password = "password123"\nkey = "PublicKey"\n`, // words
    `token_type = "Bearer"\nauth_url = "https://example.test/oauth/token"\n`,
    `private_key_path = "tests/data/key2.pem"\n`,
    `"login_password_label": "Passwort eingeben"\n`,
    `import X from '@/components/Finance/AccountPageApproved'\n`, // a path, not a key body
    `export class AlterExifExposureTimeToString1674757936889 {}\n`,
    `img = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAA"\n`,
    `integrity: "sha512-Vx3kP9mQ2zL7wR5tY8uI1oE4aS6dF0gH3jK7lZ9xC2vB5nM8qW1eR4tY6uI9oP2a"\n`,
    `jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36"\n`,
  ];
  for (const text of kept) expect(`${text}: ${suspects("x.py", text, [])}`).toBe(`${text}: `);
  // Unnamed, a random-looking base64 run is a key's body.
  expect(suspects("x.py", `blob = "${AWS_SECRET}"\n`, [])).toEqual([AWS_SECRET]);
});

test("a value one file marks secret gets the same stand-in in every file, also where nothing marks it", () => {
  const repo = gitRepo(tmp());
  mkdirSync(join(repo, "tests"), { recursive: true });
  writeFileSync(join(repo, "settings.py"), `API_TOKEN = "Qx7mK2pL9zR4wT8v"\n`);
  writeFileSync(join(repo, "tests/test_auth.py"), `def test_login(client):\n    assert client.get("/", ` +
    `headers=hdr("Qx7mK2pL9zR4wT8v")).ok\n`);
  writeFileSync(join(repo, "package-lock.json"), `{"x": "Qx7mK2pL9zR4wT8v"}\n`);
  writeFileSync(join(repo, "logo.bin"), Buffer.from([0, 1, 2, ...Buffer.from(`API_TOKEN = "Qx7mK2pL9zR4wT8v"`)]));
  commit(repo, "auth");
  const snap = join(tmp(), "snap");
  const r = takeSnapshot(repo, null, snap);
  expect(r.standIns).toEqual(["settings.py", "tests/test_auth.py"]);
  const fake = /API_TOKEN = "(\w+)"/.exec(readFileSync(join(snap, "settings.py"), "utf8"))![1]!;
  expect(fake).not.toBe("Qx7mK2pL9zR4wT8v");
  expect(readFileSync(join(snap, "tests/test_auth.py"), "utf8")).toContain(`hdr("${fake}")`);
  // A lockfile is generated, and a binary file is not text: neither is rewritten.
  expect(readFileSync(join(snap, "package-lock.json"), "utf8")).toContain("Qx7mK2pL9zR4wT8v");
  expect(readFileSync(join(snap, "logo.bin"))).toEqual(readFileSync(join(repo, "logo.bin")));
});

test("a sandbox copy gets the stand-ins the snapshot gave, for values nothing in it marks", () => {
  const repo = gitRepo(tmp());
  writeFileSync(join(repo, "settings.py"), `API_TOKEN = "Qx7mK2pL9zR4wT8v"\n`);
  writeFileSync(join(repo, "users.csv"), "alice,Qx7mK2pL9zR4wT8v\n");
  writeFileSync(join(repo, ".arnxignore"), "*.csv\n");
  commit(repo, "data");
  const snap = join(tmp(), "snap");
  const s = takeSnapshot(repo, null, snap);
  addToSandbox(repo, snap, ["users.csv"], [], { known: s.secrets });
  const fake = /"(\w+)"/.exec(readFileSync(join(snap, "settings.py"), "utf8"))![1]!;
  expect(readFileSync(join(sandboxDir(snap), "users.csv"), "utf8")).toBe(`alice,${fake}\n`);
});

test("what a run quotes of a sandbox-only file is taken out of its output and its report; a line naming it stays",
  () => {
    const repo = gitRepo(tmp());
    writeFileSync(join(repo, "fees.csv"), "country,fee\nGermany,0.0125\nFrance,0.0175 \"intl\"\n");
    writeFileSync(join(repo, ".arnxignore"), "*.csv\n");
    commit(repo, "data");
    const snap = join(tmp(), "snap");
    takeSnapshot(repo, null, snap, [], { sandbox: ["fees.csv"] });
    const runner = withSandboxFiles({ run: () => {
      mkdirSync(join(snap, ".arnx-run"), { recursive: true });
      writeFileSync(join(snap, ".arnx-run/suite.xml"), `<failure message="expected Germany,0.0125 got France,0.0175 ` +
        `&quot;intl&quot;">trace</failure>`);
      return { exitCode: 1, output: "FileNotFoundError: '/src/fees.csv'\nE   assert row == 'Germany,0.0125'\n" +
        "Germany,0.0125\nFrance,0.0175 \"intl\"\n1 failed\n", timedOut: false, seconds: 1 };
    } }, snap);
    const r = runner.run("pytest", 10);
    expect(r.output).toBe(`FileNotFoundError: '/src/fees.csv'\nE   assert row == '${SANDBOX_MARK}'\n${SANDBOX_MARK}\n` +
      "1 failed\n");
    expect(readFileSync(join(snap, ".arnx-run/suite.xml"), "utf8")).toBe(`<failure message="expected ` +
      `${SANDBOX_MARK} got ${SANDBOX_MARK}">trace</failure>`);
  });

test("stripSandbox leaves text that quotes nothing as it is", () => {
  expect(stripSandbox("all 3 passed\n", ["Germany,0.0125"])).toBe("all 3 passed\n");
  expect(stripSandbox("", ["Germany,0.0125"])).toBe("");
});

test("a value that is a name in code is never replaced: a replacement everywhere would rename the code", () => {
  for (const text of [`key = "MCP_OAUTH2_CLIENT_ID"\n`, `secret_key = "mrr_interval_count_3mo"\n`,
    `{ key = "S3_PUBLIC_IMAGES_BUCKET" }\n`, `dkim_public_key = "p=MIGfMA0GCSq"\n`]) {
    expect(`${text}: ${suspects("main.tf", text, [])}`).toBe(`${text}: `);
  }
  expect(suspects("x.py", `token = "shop_at_u_9xQ2kLm7Pz"\n`, [])).toEqual(["shop_at_u_9xQ2kLm7Pz"]);
});
