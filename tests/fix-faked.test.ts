// A test that passes on the change and fails before it shows a fix only when it fails on the old code's own behaviour.
// When it fakes something only the change uses, the old code never reaches the fake and fails for that reason.
import { expect, test } from "bun:test";
import { type Fix, fakedFix, fakedName, namesAdded } from "../src/before";

const isTest = (name: string) => name.startsWith("test_");
const DIFF = [
  "diff --git a/app/worker.py b/app/worker.py",
  "--- a/app/worker.py",
  "+++ b/app/worker.py",
  "@@ -1,3 +1,3 @@",
  "-    rows = client.get_list('top')",
  "-    row = random.choice(rows)",
  "+    row = await asyncio.to_thread(client.sample_one, 'top', ())",
  "     return row.get('data')",
  "diff --git a/tests/test_worker.py b/tests/test_worker.py",
  "--- a/tests/test_worker.py",
  "+++ b/tests/test_worker.py",
  "@@ -1 +1 @@",
  "+def only_in_a_test(): pass",
  ""].join("\n");

test("the names a change starts using: on its added source lines, not on its removed ones, tests left out", () => {
  const names = namesAdded(DIFF, isTest);
  expect(names.has("sample_one")).toBe(true);
  expect(names.has("to_thread")).toBe(true);
  expect(names.has("client")).toBe(false); // the old line used it too
  expect(names.has("only_in_a_test")).toBe(false);
});

test("a fake of such a name is found, by whatever means the test fakes it", () => {
  const names = new Set(["sample_one"]);
  for (const line of [
    'monkeypatch.setattr(w.client, "sample_one", Mock(return_value=None))',
    'patch("app.worker.client.sample_one")',
    "with patch.object(client, 'sample_one') as m:",
    "client.sample_one = Mock()",
    'vi.spyOn(client, "sample_one").mockReturnValue(null)',
    'jest.spyOn(client, "sample_one")',
  ]) expect([line, fakedName(`def test_x():\n    ${line}\n`, names)]).toEqual([line, "sample_one"]);
});

test("using the name, or faking another, is no fake of it", () => {
  const names = new Set(["sample_one", "lambda"]);
  for (const source of [
    "def test_x():\n    assert client.sample_one('top', ()) == 1\n",
    'def test_x(monkeypatch):\n    monkeypatch.setattr(client, "other", lambda: None)\n',
    "m = Mock(return_value=1)\nassert m() == 1\n",
  ]) expect([source, fakedName(source, names)]).toEqual([source, null]);
});

const fixed: Fix = { status: "fixed", detail: "fails on the code before the change (3 runs) and passes after: the " +
  "change fixes this (IndexError)", runs: ["failed", "failed", "failed"], message: "IndexError" };

test("a fix shown by such a test is no proof; any other outcome stands", () => {
  const f = fakedFix(fixed, "sample_one");
  expect(f.status).toBe("unknown");
  expect(f.detail).toBe("fails on the code before the change (3 runs), but it fakes `sample_one`, which the change " +
    "starts using: no proof of a fix");
  const same: Fix = { status: "unchanged", detail: "passes", runs: [] };
  expect(fakedFix(same, "sample_one")).toBe(same);
});
