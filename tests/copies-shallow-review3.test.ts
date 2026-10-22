// Tests arnx wrote when it reviewed its own Codex-feedback fixes (review 20261022-d986ae), kept as accepted; S3 and
// S7 stay skipped (the owner marked them intended).
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLAIN } from "../src/color";
import { markInteractive, type Key } from "../src/mark";
import { render } from "../src/report";
import { shallowKind } from "../src/shallow";
import { COPY_SUFFIX, readCopies, suffixReviewCopies } from "../src/testround";
import { sampleReview } from "./helpers/review";

const tmp = () => mkdtempSync(join(tmpdir(), "arnx-gen-"));
const keys = (ks: Key[]): AsyncIterator<Key> => {
  let i = 0;
  return { async next() { return i < ks.length ? { value: ks[i++]!, done: false } : { value: "quit", done: true }; } };
};

function collide() {
  const repo = tmp();
  const root = join(repo, ".arnx", "reviews", "r1", "projects", "app", "tests");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "a.test.js"), "OLD");
  writeFileSync(join(root, `a.test.js${COPY_SUFFIX}`), "NEW");
  return { repo, root };
}

test("S1 readCopies prefers the suffixed copy when both forms exist", () => {
  const { root } = collide();
  expect(readCopies(root, /\.test\.js$/)["a.test.js"]).toBe("NEW");
});

test("S2 suffixReviewCopies does not destroy an existing suffixed copy", () => {
  const { repo, root } = collide();
  suffixReviewCopies(repo);
  const all = readdirSync(root).map((f) => readFileSync(join(root, f), "utf8"));
  expect(all).toContain("NEW");
});

// arnx review 20261022-d986ae: not confirmed
test.skip("S3 suffixReviewCopies leaves files readCopies would not read alone", () => {
  const repo = tmp();
  const root = join(repo, ".arnx", "reviews", "r1", "projects", "app", "tests");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "data.json"), "{}");
  suffixReviewCopies(repo);
  expect(readdirSync(root)).toEqual(["data.json"]);
});

test("S5 suffixReviewCopies skips a projects entry that is a file and stray files in reviews", () => {
  const repo = tmp();
  const reviews = join(repo, ".arnx", "reviews");
  mkdirSync(join(reviews, "x"), { recursive: true });
  writeFileSync(join(reviews, "x", "projects"), "not a dir");
  writeFileSync(join(reviews, ".DS_Store"), "");
  expect(() => suffixReviewCopies(repo)).not.toThrow();
});

test("S4 same leaf name in different suites uses the right body", () => {
  const src = `describe('exports', () => { it('works', () => {\n expect(typeof api.run).toBe('function');\n }); });\n` +
    `describe('requests', () => { it('works', () => {\n expect(api.run(2)).toBe(4);\n }); });\n`;
  expect(shallowKind(src, "requests > works")).toBeNull();
});

test("S6 toHaveProperty with a value is not existence-only", () => {
  const src = "test('rejects invalid input', () => {\n  expect(handleRequest({})).toHaveProperty('status', 400);\n});";
  expect(shallowKind(src, "rejects invalid input")).toBeNull();
});

test("S8 a name quoted earlier in another test's body does not hide the real test", () => {
  const src = "it('first', () => {\n  const s = fs.readFileSync('app.js', 'utf8');\n  expect(s).toMatch(/x/);\n  log('rejects a wrong key');\n});\n" +
    "it('rejects a wrong key', () => {\n  expect(api(1)).toBe(2);\n});\n";
  expect(shallowKind(src, "rejects a wrong key")).toBeNull();
});

// arnx review 20261022-d986ae: not confirmed
test.skip("S7 enter with nothing ticked does not record an unmarked finding as chosen", async () => {
  const review = sampleReview();
  const r = await markInteractive(review, render(review), { paint: PLAIN, width: 80, draw: () => {},
    keys: keys(["right", "down", "enter", "enter", "enter"]) });
  expect(r!.chosen).not.toContain("F2");
});

test("readCopies strips the suffix and reads legacy names; suffix migration is idempotent", () => {
  const repo = tmp();
  const root = join(repo, ".arnx", "reviews", "r1", "tests");
  mkdirSync(join(root, "d"), { recursive: true });
  writeFileSync(join(root, "d", "t.test.js"), "x");
  expect(suffixReviewCopies(repo)).toBe(1);
  expect(suffixReviewCopies(repo)).toBe(0);
  expect(readCopies(root, /\.test\.js$/)).toEqual({ "d/t.test.js": "x" });
});

test("shallowKind: plain behavioural test is null, python source check detected", () => {
  expect(shallowKind("def test_a():\n    assert f(1) == 2\n", "test_a")).toBeNull();
  expect(shallowKind("def test_a():\n    assert 'x' in inspect.getsource(m)\n", "test_a")).toBe("source-text");
});
