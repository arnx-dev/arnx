import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { python } from "../src/adapters/python";
import { clearReach, readReach, reachedSince } from "../src/reached";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const notes = (snap: string, name: string, body: string) => {
  mkdirSync(join(snap, ".arnx-run"), { recursive: true });
  writeFileSync(join(snap, ".arnx-run", name), body);
};

test("a run's notes are repository paths, ran over loaded, from every process, and only the code's own", () => {
  const snap = tmp();
  notes(snap, "reached-7.txt", "loaded /src/app/a.py\nran /src/app/a.py\nloaded /src/app/b.py\nran /usr/lib/python3.12/os.py\n" +
    "loaded /src/.venv/lib/python3.12/site-packages/y.py\nloaded /src/.arnx-run/py/sitecustomize.py\nnot a note\n");
  notes(snap, "reached-9.txt", "ran /src/app/b.py\nloaded /src/app/c.py\n");
  notes(snap, "final-1.xml", "ran /src/app/x.py\n");
  expect(Object.fromEntries(readReach(snap))).toEqual({ "app/a.py": "ran", "app/b.py": "ran", "app/c.py": "loaded" });
});

test("no notes is no data", () => {
  expect(readReach(tmp()).size).toBe(0);
});

test("what the probe's run already showed does not count: a file it ran, or one it loaded and the tests only load", () => {
  const now = new Map([["a.py", "ran"], ["b.py", "ran"], ["c.py", "loaded"], ["d.py", "loaded"], ["e.py", "ran"]] as const);
  const probe = new Map([["a.py", "ran"], ["b.py", "loaded"], ["c.py", "loaded"]] as const);
  expect(reachedSince(now, probe)).toEqual(["b.py", "d.py", "e.py"]);
});

test("clearing takes the notes and leaves the reports", () => {
  const snap = tmp();
  notes(snap, "reached-1.txt", "ran /src/a.py\n");
  notes(snap, "final-1.xml", "<x/>");
  clearReach(snap);
  expect(existsSync(join(snap, ".arnx-run", "reached-1.txt"))).toBe(false);
  expect(existsSync(join(snap, ".arnx-run", "final-1.xml"))).toBe(true);
  clearReach(tmp()); // no report folder yet
});

test("pytest runs with arnx's sitecustomize first on PYTHONPATH, the project's own path kept after it", () => {
  const cmd = python.command("python -m pytest -q {targets}", ["t.py"], "/src/.arnx-run/final-1.xml", "pytest");
  expect(cmd.startsWith("export PYTHONPATH=/src/.arnx-run/py${PYTHONPATH:+:$PYTHONPATH}; python -m pytest -q t.py -p "))
    .toBe(true);
});

test("the report setup writes the hook into the report folder, alone in its own folder", () => {
  const snap = tmp();
  python.reportSetup!(snap, "pytest");
  const hook = join(snap, ".arnx-run", "py", "sitecustomize.py");
  expect(existsSync(hook)).toBe(true);
  const text = readFileSync(hook, "utf8");
  for (const part of ["PY_START", "addaudithook", "reached-%d.txt"]) expect(text).toContain(part);
});
