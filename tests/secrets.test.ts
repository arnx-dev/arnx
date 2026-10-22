import { expect, test } from "bun:test";
import { excludePathspecs, firstUnpinned, hasSecretContent, isSecretEnvName, isSecretPath, secretPins }
  from "../src/secrets";

test("test_secret_paths", () => {
  for (const p of [".env", "app/.env.production", "deploy/key.pem", "id_rsa", "home/.netrc", "credentials-prod.json"]) {
    expect(isSecretPath(p)).toBe(true);
  }
  for (const p of ["env.py", "keyboard.py", "monkey.txt", "src/environment.md"]) expect(isSecretPath(p)).toBe(false);
});

test("test_secret_content", () => {
  expect(hasSecretContent("-----BEGIN RSA PRIVATE KEY-----\nabc")).toBe(true);
  expect(hasSecretContent("aws = 'AKIAABCDEFGHIJKLMNOP'")).toBe(true);
  expect(hasSecretContent("token: ghp_" + "a".repeat(36))).toBe(true);
  expect(hasSecretContent("ANTHROPIC=sk-ant-" + "x".repeat(30))).toBe(true);
  expect(hasSecretContent("def key_for(user): return user.id")).toBe(false);
});

test("current OpenAI key shapes are secrets too (project, service-account and admin keys hold dashes)", () => {
  for (const kind of ["proj", "svcacct", "admin"]) {
    const key = `sk-${kind}-${"Ab3_x-".repeat(8)}`;
    expect(hasSecretContent(`OPENAI_API_KEY=${key}`)).toBe(true);
    expect(firstUnpinned(`k = "${key}"`, [])).toEqual({ line: 1, label: `sk-${kind}-…` });
  }
  expect(hasSecretContent("sk-proj-short")).toBe(false);
  expect(hasSecretContent("task-project-name")).toBe(false);
});

test("a key starts a token: sk- or AKIA inside a longer word is not a key", () => {
  expect(hasSecretContent("task-" + "a".repeat(40))).toBe(false);
  expect(hasSecretContent("desk-" + "B".repeat(40))).toBe(false);
  expect(hasSecretContent("XAKIAABCDEFGHIJKLMNOP")).toBe(false);
  for (const before of ["", " ", "=", "\"", "'", ":", "_", "-", "\n", "(", "/"]) {
    expect(hasSecretContent(`${before}sk-${"a".repeat(40)}`)).toBe(true);
    expect(hasSecretContent(`${before}sk-ant-${"x".repeat(30)}`)).toBe(true);
    expect(hasSecretContent(`${before}AKIAABCDEFGHIJKLMNOP`)).toBe(true);
  }
});

test("test_secret_env_names", () => {
  expect(isSecretEnvName("STRIPE_API_KEY") && isSecretEnvName("db_password")).toBe(true);
  expect(isSecretEnvName("REDIS_PORT") || isSecretEnvName("POSTGRES_HOST_AUTH_METHOD")).toBe(false);
});

test("test_exclude_pathspecs_cover_arnx_dir", () => {
  const specs = excludePathspecs();
  expect(specs).toContain(":(exclude).arnx");
  expect(specs).toContain(":(exclude,glob)**/.env");
});

test("a file's key-shaped strings are pinned by short hashes; it is kept only while every one is pinned", () => {
  const fixture = "AWS = 'AKIAIOSFODNN7EXAMPLE'\nGH = 'ghp_" + "a".repeat(36) + "'\nAGAIN = 'AKIAIOSFODNN7EXAMPLE'\n";
  const pins = secretPins(fixture);
  expect(pins).toHaveLength(2); // unique strings
  expect(pins.every((p) => /^[0-9a-f]{16}$/.test(p))).toBe(true);
  expect(pins.join("")).not.toContain("AKIA");
  expect(firstUnpinned(fixture, pins)).toBeNull();
  expect(firstUnpinned(fixture, [])).toEqual({ line: 1, label: "AKIA…" });
  expect(firstUnpinned(fixture + "NEW = 'xoxb-1234567890-abc'\n", pins)).toEqual({ line: 4, label: "xoxb-…" });
  expect(firstUnpinned("-----BEGIN RSA PRIVATE KEY-----\n", [])).toEqual({ line: 1, label: "a private key" });
  expect(firstUnpinned("def key_for(user): return user.id", [])).toBeNull();
});
