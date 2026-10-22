// Tests that check the code's text, or only that something exists, are named as such: a change can pass them without
// fixing the behaviour.
import { expect, test } from "bun:test";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shallowKind } from "../src/shallow";
import { COPY_SUFFIX, readCopies, suffixReviewCopies } from "../src/testround";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();

const JS = `const fs = jest.requireActual('fs');
describe('app wiring', () => {
  it('API key comparison is constant-time', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
    expect(src).toMatch(/timingSafeEqual/);
  });

  it('rejects a wrong key', async () => {
    expect((await request(app).get('/balance').set('x-api-key', 'wrong')).status).toBe(401);
  });
  it('splitProfile defines update and cancel', () => {
    expect(typeof api.splitProfile.update).toBe('function');
    expect(typeof api.splitProfile.cancel).toBe('function');
  });
  it('reads a fixture', () => {
    const data = JSON.parse(fs.readFileSync('fixtures/a.json', 'utf8'));
    expect(parse(data).ok).toBe(true);
  });
});
`;

test("a test that matches a source file's text, or only checks that something exists, is shallow", () => {
  expect(shallowKind(JS, "app wiring > API key comparison is constant-time")).toBe("source-text");
  expect(shallowKind(JS, "app wiring > splitProfile defines update and cancel")).toBe("existence");
  expect(shallowKind(JS, "app wiring > rejects a wrong key")).toBeNull();
  expect(shallowKind(JS, "app wiring > reads a fixture")).toBeNull(); // a data file, and behaviour checked
  expect(shallowKind(JS, "app wiring > not there")).toBeNull();
  expect(shallowKind(undefined, "x")).toBeNull();
  const py = "import inspect\n\ndef test_uses_compare_digest():\n    assert 'compare_digest' in inspect.getsource(auth)\n\n" +
    "def test_has_cancel():\n    assert hasattr(api, 'cancel')\n    assert callable(api.cancel)\n\n" +
    "def test_cancel_works():\n    assert api.cancel(1) is None\n";
  expect(shallowKind(py, "test_uses_compare_digest")).toBe("source-text");
  expect(shallowKind(py, "tests/test_a.py::test_has_cancel")).toBe("existence");
  expect(shallowKind(py, "test_cancel_works")).toBeNull();
});

test("a review's kept tests carry a suffix test runners do not match; older reviews are renamed, both read", () => {
  const repo = tmp();
  const old = join(repo, ".arnx", "reviews", "20261021-2a4a65", "projects", "app", "tests", "__tests__", "gen");
  mkdirSync(old, { recursive: true });
  writeFileSync(join(old, "a.test.js"), "test('a', () => {});\n");
  writeFileSync(join(old, `b.test.js${COPY_SUFFIX}`), "test('b', () => {});\n");
  const root = join(repo, ".arnx", "reviews", "20261021-2a4a65", "projects", "app", "tests");
  expect(Object.keys(readCopies(root, /\.test\.js$/))).toEqual(["__tests__/gen/a.test.js", "__tests__/gen/b.test.js"]);
  expect(suffixReviewCopies(repo)).toBe(1);
  expect(readdirSync(old).sort()).toEqual([`a.test.js${COPY_SUFFIX}`, `b.test.js${COPY_SUFFIX}`]);
  expect(Object.keys(readCopies(root, /\.test\.js$/))).toEqual(["__tests__/gen/a.test.js", "__tests__/gen/b.test.js"]);
  expect(suffixReviewCopies(repo)).toBe(0);
});
