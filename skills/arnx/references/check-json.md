# arnx check --json

`arnx check --json` prints one JSON object on stdout (progress goes to stderr; `--quiet` turns it off) and exits
with its `exit_code`. This page is its contract, `schema_version` 1; arnx's tests check every field below. When the
command fails before checking (no `.arnx/config.toml`, no approved environment, no Docker, no such review), stdout
holds the error object every arnx command gives ([json.md](json.md)): `schema_version`, `command` (`check`),
`result: "error"`, `error` (the message, also on stderr) and `exit_code` 2 or 3; a wrong option is
`result: "usage-error"`.

`arnx check` runs the accepted tests (what `arnx accept` kept in `.arnx/tests/`, each at the path it runs from) of
every project in the approved sandbox, on the working tree as it is now. Test ids are relative to the project, at
the path each test runs from; `files` are where they are kept.
`arnx check --review [id] --json` runs a review's confirmed tests instead: see [With --review](#with---review).

## Fields

| Field | Type | Meaning |
|---|---|---|
| `schema_version` | number | 1. |
| `command` | string | `check`. |
| `result` | string | `pass`, `fail`, `no-report`, `nothing-accepted` or `tests-changed` (see below). |
| `exit_code` | number | 0, 1, 2, 3 or 4, the same as the process exit code. |
| `projects` | array | One entry per project with accepted tests: see [Each project](#each-project). Empty when nothing ran. |
| `changed` | array | Accepted test files edited or deleted since `arnx accept` recorded them, or whose entry in `.arnx/accepted-tests.json` was changed or removed: see [Each changed file](#each-changed-file). Non-empty only with `tests-changed`. |

## Each project

| Field | Type | Meaning |
|---|---|---|
| `project` | string | The project's name in `.arnx/review.yaml`. |
| `files` | array of strings | The accepted test files run, relative to the repository. |
| `no_report` | boolean | The tests did not report (timed out, or the runner could not start). |
| `no_report_reason` | string or null | With `no_report`: why (`the tests timed out after 900 s`, `the runner could not start (exit 127)`, `the runner wrote no report (exit 1)`); else null. |
| `log` | string or null | With `no_report`: the runner's output, a file relative to the repository (`.arnx/run/check-<project>.log`); else null. |
| `passed` | array of strings | Test ids that passed. |
| `accepted` | array of strings | The ids, of those that passed or failed, that are accepted tests: the tests behind findings marked real (and answers the code disagrees with). The rest are other tests the review wrote into the same files. Read from `.arnx/accepted-tests.json` (committed, so a fresh clone or CI tells them apart too); for a file recorded by an older arnx, from its review in `.arnx/reviews/`; with neither, every test in the file counts as accepted. |
| `failed` | array | Tests that failed: see [Each failed test](#each-failed-test). |
| `skipped` | number | Tests skipped: one accept could not cut out of a kept file, or (accepted by an arnx before 0.1.2) not confirmed, marked intended or noise, or set aside. |

## Each failed test

| Field | Type | Meaning |
|---|---|---|
| `test_id` | string | The test, as the runner names it (`path::name`). |
| `outcome` | string | `failed` (an assertion) or `error` (it could not run). |
| `message` | string | The failure as the runner reported it; the first line is the assertion. |
| `accepted` | boolean | An accepted test (a bug not fixed yet), or another test in an accepted file (a change broke it). |

## Each changed file

| Field | Type | Meaning |
|---|---|---|
| `path` | string | The accepted file, relative to the repository. |
| `review` | string | The review whose `arnx accept` wrote it. |
| `change` | string | `modified` or `deleted` (the file differs from its recorded sha256, or is gone), `repinned` (its entry in `.arnx/accepted-tests.json`, its sha256 or its `tests`, was changed, and not by `arnx accept` on this machine) or `unpinned` (its entry was removed, or the whole file). |

## Results

| `result` | Exit | Meaning |
|---|---|---|
| `pass` | 0 | Every accepted test passes: the bugs they lock are fixed. |
| `fail` | 1 | Some accepted tests fail: a bug not fixed yet, or a change that broke what they lock. Fix the code. A test that is wrong about a real bug is the user's call: they mark its finding `rewrite` with a reason in review.md, then `arnx accept --again <id>`. |
| `no-report` | 2 | Some tests did not report. |
| `nothing-accepted` | 3 | No accepted tests yet (nothing has been through `arnx accept`). |
| `tests-changed` | 4 | Accepted test files changed since accept, so nothing ran: a test edited until it passes proves nothing. The user restores them (`arnx accept --again <id>`, or `git checkout` when the committed copy is the accepted one: `arnx check` without `--json` names it then), or records an intended edit with `arnx accept --keep-edits`. |

`.arnx/accepted-tests.json` records, for each file `arnx accept` wrote, its sha256 and its accepted tests (`tests`:
each test's name after `file::`, parameters dropped; empty for a support file or one holding only an answer's passing
tests):

```json
{ "schema_version": 1, "files": { ".arnx/tests/tests/arnx/r20261011_a1b2c3/test_discount_over_100.py": {
  "sha256": "9f2c…", "review": "20261011-a1b2c3", "tests": ["test_F1", "test_F2"] } } }
```

An entry without `tests` (written by an older arnx) still reads. Files accept never recorded (kept by an older arnx)
are run without that check. The record is checked too: an entry's sha256 and `tests` are trusted only
when they are the ones committed at HEAD or ones `arnx accept` (or `--keep-edits`) wrote on this machine, which keeps
its own copy in the user's config directory, outside the repository. An entry changed or removed any other way is
`repinned` or `unpinned`, exit 4: an edited `tests` list could otherwise relabel a failing accepted test as another
test.

## With --review

`arnx check --review <id> --json` (no id: the latest review) runs the review's **confirmed** tests, the ones that
proved its findings, from `.arnx/reviews/<id>/`, on the working tree as it is now, in the approved sandbox. Nothing is
accepted, copied into the repository or recorded, and no model is called (no cost). Use it right after fixing a
review's findings, before the user has accepted anything. A test that fails in one run is still failing; a fix
counts only when its test passes in every run (3 by default, `runs` in `.arnx/config.toml`), as a review decides.

| Field | Type | Meaning |
|---|---|---|
| `schema_version` | number | 1. |
| `command` | string | `check`. |
| `review` | string | The review id. |
| `result` | string | `pass`, `fail`, `no-report` or `nothing-confirmed` (see below). |
| `exit_code` | number | 0, 1 or 2, the same as the process exit code. |
| `findings` | array | One entry per confirmed finding: see [Each rechecked finding](#each-rechecked-finding). |

## Each rechecked finding

| Field | Type | Meaning |
|---|---|---|
| `id` | string | The finding (`F1`), as in review.json. |
| `project` | string | Its project. |
| `test_id` | string | Its test. |
| `status` | string | `fixed` (passed in every run), `still-failing` (failed or errored in a run) or `no-report`. |
| `runs` | array of strings | Its outcome in each run: `passed`, `failed`, `error`, `skipped`, `absent` (not in the report), `missing` (no report). |
| `message` | string | The failure when it still fails; empty when fixed. |

## Results with --review

| `result` | Exit | Meaning |
|---|---|---|
| `pass` | 0 | Every confirmed test passes now: the review's bugs are fixed. |
| `fail` | 1 | Some still fail. Fix the code (not the test) and run it again. |
| `no-report` | 2 | Some tests did not report (and none of those failed). |
| `nothing-confirmed` | 0 | The review has no confirmed findings. |

A review that does not exist, or no review yet, is the error object (`result: "error"`), exit 3.
