# arnx --json

Every arnx command takes `--json`. Then:

- stdout carries exactly one JSON object, pretty-printed, and nothing else;
- every line meant for a person (progress, summaries, `✓`/`✗` lines, errors) goes to stderr;
- nothing is asked: a command that would ask (setup's approval, `cloud on`, `consent`) needs `--yes`, and a missing
  consent to send code stops the command with an `error` object;
- the process exit code is the object's `exit_code`.

`arnx check --json` and `arnx check --review --json` keep their own fields: [check-json.md](check-json.md).

## Shared fields

| Field | Type | Meaning |
|---|---|---|
| `schema_version` | number | 1. |
| `command` | string | The command, as typed: `init`, `doctor`, `review`, … |
| `result` | string | One word: `ok`, `fail`, or the command's own (below). |
| `exit_code` | number | The process exit code: 0 fine; 1 confirmed findings (`review`) or failing tests (`check`); 2 could not finish or a usage error; 3 setup needed; 4 accepted tests edited (`check`). |

Every other field is the command's own, in snake_case. Paths are relative to the repository root, times are ISO
8601, money is a number of US dollars in a field ending `_usd`.

## Results every command can give

| `result` | When | Other fields |
|---|---|---|
| `error` | arnx stopped the command (no config, no consent, no such review, …) | `error`: the message also printed on stderr |
| `usage-error` | an unknown option, a missing value, an extra argument, an unknown command | `error`: what was wrong |
| `not-ready` | `setup` or `review` stopped on doctor's checks before sending anything | `checks`: the failing ones, each `{ name, ok: false, detail }` |

## Each command

### init

| Field | Type | Meaning |
|---|---|---|
| `state` | string | `created` (there was no `.arnx/config.toml`), `already-initialized` (it was there and is kept as it is) or `replaced` (`--force` rewrote it). |
| `files` | array | The files init looks after, each `{ path, action }`: `.arnx/config.toml` and `.arnxignore`; `action` is `created`, `kept` or `replaced`. |
| `cloud` | boolean | Models from arnx cloud. `false` after `--cloud` on an existing configuration means it kept your own keys: `arnx cloud on` switches. |
| `next` | array of strings | The commands to run next, in order (`["arnx setup"]`, or `["arnx login", "arnx setup"]` with arnx cloud and no login); empty in a repository arnx cannot review. |
| `skill_installed` | boolean | This arnx's skill is in every skill folder of the repository; `false`: `arnx skill install`. |
| `unsupported` | string | Only in a repository written in languages arnx does not review: the note init prints, naming them. |

| `result` | Exit | When |
|---|---|---|
| `ok` | 0 | Always, once the files are there (a configuration that does not read is kept: `arnx doctor` says why). |

### doctor

| Field | Type | Meaning |
|---|---|---|
| `ready` | boolean | A review can run now. |
| `checks` | array | Every check, in doctor's order, each `{ name, ok, detail }`: `name` is `configuration`, `models`, `keys` (your own keys) or `login` and `credits` (arnx cloud), `docker`, `languages` (only when it fails: the repository is written only in languages arnx does not review), `consent`, `environment`; `ok` is `true` (✓), `false` (✗) or `null` (·, not done yet: the flow does it next, not a problem); `detail` is the line's text. |
| `next` | string or null | The command to run next; `null` while a check fails (fix the `ok: false` ones). |
| `models` | string | `byom` (your own keys) or `cloud` (arnx cloud). Absent when the models in effect are unknown (no configuration, or a bad `ARNX_MODELS`). |
| `providers` | array | The provider tables a role uses, each `{ name, api, host, key_env, key_set }` (`key_env` is the variable's name; its value is never shown). Empty when only built-in providers are used. |
| `coverage` | object | With an approved environment: `projects` (each `{ name, owned, used, untracked: { owned, used } }`, file counts), `uncovered` (each `{ path, reason, files, untracked }`: what no project tests, and why), `unexplained` (source files no project owns or uses and no `uncovered` entry names). Absent otherwise. |
| `jev` | object | Only when doctor shows a JEV line: `{ on, key_set, detail }` (`on`: `jev = true` in the config; `key_set`: `JEV_API_KEY` is set). Experimental, never a check. |
| `telemetry` | object | `{ enabled, reason }`: `reason` is why it is off (`in .arnx/config.toml`, `ARNX_TELEMETRY is set`, …), `null` when enabled. |

| `result` | Exit | When |
|---|---|---|
| `ready` | 0 | Every check is ✓. |
| `not-ready` | 3 | A check failed (✗) or a step is not done yet (·, such as the consent or the environment). Unlike setup's and review's `not-ready`, `checks` holds every check. |

### next

| Field | Type | Meaning |
|---|---|---|
| `where` | string | Where the repository is in the flow (`not set up`, `no test environment yet`, …). |
| `next` | string | The command to run now (`arnx setup`, `arnx review`, …; sometimes a git command, or what to fix). |
| `why` | string or null | What it does, or why it comes next; `null` when there is nothing to add. |
| `then` | string or null | The step after `next` (`arnx accept <id>` after triage, `arnx check` after fixing), or `null`. |
| `note` | string or null | A line about the change (untracked files left out or included), or `null`. |
| `phase` | string | `1. Prepare`, `2. Review`, `3. Decide` or `4. Fix`. |

| `result` | Exit | When |
|---|---|---|
| `ok` | 0 | Always. |

### consent

| Field | Type | Meaning |
|---|---|---|
| `recorded` | string | The line written to `.arnx/config.toml`: `consent_at`, or `cloud_consent_at` with `--cloud`. |
| `at` | string | When (ISO 8601). |
| `to` | string | Where code goes from now on: `your model provider` or `arnx cloud`. |

| `result` | Exit | When |
|---|---|---|
| `ok` | 0 | Recorded (with `--yes`). Without `--yes` nothing can be asked: `error`, exit 3, nothing written. |

### cloud

| Field | Type | Meaning |
|---|---|---|
| `models` | boolean | `[cloud] models` after the change: `true` after `on`, `false` after `off`. |
| `next` | array of strings | The text's `Next:` and `Then:` lines. After `on`: `["arnx login", "arnx setup"]` without a login when the flow's next step calls models (setup, review, accept), else the flow's next step (and its then). After `off`: `["arnx doctor"]` with keys missing, else the flow's next step. |
| `already_on` | boolean | After `on` only: `[cloud] models` was already true (nothing written but a missing consent). |
| `logged_in` | boolean | After `on` only: this machine is logged in to arnx cloud; `false` with `next` not starting at `arnx login`: the login is needed before the next review. |
| `missing_keys` | array of strings | After `off` only: the names of the variables your own keys need and that are not set (export them). |

| `result` | Exit | When |
|---|---|---|
| `ok` | 0 | Switched. `on` without a recorded arnx cloud consent needs `--yes`; without it: `error`, exit 3, nothing changed. |

### login, logout, credits

`login`:

| Field | Type | Meaning |
|---|---|---|
| `email` | string or null | The account logged in. |
| `url` | string | The arnx cloud address. |

The code to enter and the page to open are on stderr while it waits.

`logout`:

| Field | Type | Meaning |
|---|---|---|
| `deleted` | boolean | A login was there and is deleted; `false`: there was none. |
| `path` | string or null | The credentials file (`~/…` under the home directory); `null` with no config directory. |

`credits`:

| Field | Type | Meaning |
|---|---|---|
| `balance_usd` | number | The available balance (the text's "Available"); negative is a debt (nothing new starts until a top-up). |
| `held_usd` | number | Reserved by reviews in progress (not spendable; `balance_usd` already leaves it out). |
| `reserved_usd` | number | The same as `held_usd`, under the text's name ("Reserved"). |
| `email` | string or null | The account's email. |
| `account_id` | string | The account. |
| `topup_url` | string | Where to top up. |

| `result` | Exit | When |
|---|---|---|
| `ok` | 0 | Done. Not logged in (`credits`, exit 3), a refused or expired login, arnx cloud unavailable, or arnx cloud not open (its `not_open` answer): `error` (exit 2). |

### setup

`arnx setup` finds how each project's tests run in Docker, writes `.arnx/review.yaml` and, once approved, runs the
suites again and stamps it. With `--json` nothing is asked: the consent to send code and the approval need `--yes`
(without a recorded consent: `error`, exit 3, nothing sent; without `--yes`, setup runs and saves the file but approves
nothing: `not-approved`, exit 3). With `--yes` an environment is approved with its warnings; they are in `warnings` and
in `.arnx/setup/approval.md`.

| Field | Type | Meaning |
|---|---|---|
| `approved` | boolean | The environment is approved now. |
| `auto_approved` | boolean | Approved by `--yes`, not by a person at a terminal. |
| `projects` | array | One entry per project of the file setup wrote (or of its last attempt): `{ name, runs_in, image, runner, suite, ok, accepted_failing, unexpected }`. `runs_in`: the project's folder; `suite`: its suite's counts (`3 passed`), or why it failed, `null` when it never ran; `ok`: it passed (in the approval, when one ran); `accepted_failing` and `unexpected` as in `approve`. |
| `files` | object or null | What the files line counts: `projects` (each `{ name, owned, used }`), `not_tested` (the `uncovered` paths) and `untracked_left_out` (untracked files not read: without `--untracked`). Which files a project owns says nothing about how well its tests cover them. `null` when setup failed. |
| `warnings` | array of strings | The `!` lines of "Check before approving": tests skipped, files set aside as known failing, commands that ignore their errors (`|| true`), secret-looking files allowed. |
| `review_yaml` | string or null | Where the file is: `.arnx/review.yaml`; after a failure the last attempt, unapproved (`.arnx/setup/review.yaml` when `.arnx/review.yaml` is approved and kept); `null` when there was no attempt. |
| `approval_record` | string or null | `.arnx/setup/approval.md` once approved (who, when, the file's sha256 and the warnings); else `null`. |
| `cost_usd` | number | What setup's model calls cost. |
| `seconds` | number | How long setup took, approval included. |
| `failure` | object or null | Why setup failed: `{ kind, reason, failing }`. `kind` is `environment` (it never got a suite running: a build that fails, a runner that does not start, the budget or the turns used up, no proposal) or `tests` (the suite runs and the current code fails tests outside `known_failing`; `failing` holds their ids). `null` unless `fail`. |
| `next` | array of strings | The commands to run next: `arnx review` once approved; `arnx approve` (after fixing `review_yaml`, or to approve it); `arnx setup --force` when there was no attempt. |

| `result` | Exit | When |
|---|---|---|
| `ok` | 0 | Set up and approved (`--yes`). |
| `not-approved` | 3 | No `--yes`: the file is written, nothing approved. |
| `fail` | 2 | No working environment, tests failing on the current code, or the approval's run failed. `.arnx/review.yaml` is already set up (no `--force`): `error`, exit 2. |

### approve

`arnx approve` runs every project's suite (or one, with `--project`) and stamps `.arnx/review.yaml` as approved.
Approving is the user's decision: with `--json` nothing is asked, so without `--yes` nothing is run or approved. Each
approval is recorded, with its warnings, in `.arnx/setup/approval.md` (a local file).

| Field | Type | Meaning |
|---|---|---|
| `approved` | boolean | The environment is approved now. |
| `projects` | array | One entry per suite that ran, in order: `{ name, ok, summary, accepted_failing, unexpected }`; `summary` is the suite's counts (`3 passed`), or why it failed. `accepted_failing`: tests kept by `arnx accept` that still fail (their bugs are not fixed yet; `arnx check` runs them); they do not block approval while each file matches its pin in `.arnx/accepted-tests.json`, and one changed since accept does. `unexpected`: the ids of the failing tests that block it (outside `known_failing` and the accepted tests). Empty when nothing ran. |
| `detail` | string | Only with `fail`: why it was not approved: per failing suite, up to 5 failing tests and the path of its whole output (`.arnx/run/approve-<project>.log`). |
| `next` | array of strings | The commands to run next: `arnx review` once approved, else `arnx approve` (for the user). |

| `result` | Exit | When |
|---|---|---|
| `ok` | 0 | Every suite passed; approved. |
| `fail` | 2 | A suite failed (or `--project` names no project, or others changed since their approval); not approved. |
| `not-approved` | 3 | No `--yes`: nothing was asked, run or approved. |

### review

A summary of the review, as the terminal shows it. The whole review is `review_json`:
[review-json.md](review-json.md).

| Field | Type | Meaning |
|---|---|---|
| `review_id` | string | The review id, for `arnx check --review <id>` and `arnx accept <id>`. |
| `review_md`, `review_json` | string | The review for people and for programs, relative to the repository. |
| `change` | string | What was reviewed, such as `uncommitted (base 1a2b3c4)`. |
| `files_changed`, `added`, `removed` | number | Files in the change; lines added and removed. |
| `status` | string | `complete`, `incomplete` (see `problems`), or `partly-covered` (changed source files no test refers to: `not_tested`). |
| `issues` | number | Entries in `findings`: the summary's numbered rows. |
| `findings` | array | One entry per issue the change may have caused, as the summary groups and orders them (most severe first): `{ ids, state, confirmed, regression, projects, title, severity }`. `ids`: the findings (`F1`) with this cause; `state`: their verdicts in words (`confirmed`, `disputed`, `not challenged`, `depends on Q1`, or counts such as `1 confirmed, 1 disputed`); `confirmed`: one of them is confirmed (exit 1); `regression`: one passed before the change; `title`: the problem in a few words; `severity`: `high`, `medium`, `low` or `null` (the grouping model's estimate). |
| `pre_existing` | array of strings | Findings that fail the same way before the change: not caused by it, never the exit code. |
| `questions` | array | `{ id, question, project, optional }`: `Q1` first. Only the user answers them. `optional`: no issue waits on it (a test another finding proves already settles the issue); an answer still lets `arnx accept` write a test. |
| `tests_written` | number | Tests the reviewer wrote. |
| `cost_usd` | number | What the review cost. |
| `seconds` | number | How long it took. |
| `untracked_left_out` | number | Untracked files not sent (0 when none). |
| `problems` | array of strings | Why the review is incomplete or only partly covered, in words; empty when complete. |
| `provider_failures` | array of strings | A sentence per model provider that was down or refused its key; empty when none. |
| `not_tested` | array of strings | Changed files no arnx test refers to, and files no project covers. |
| `your_call` | string or null | What only the user can decide, as the summary says it: issues not proven (disputed, or waiting on a question) and the questions an issue waits on; or that every issue comes marked real. `null` when findings are marked one by one (not grouped) or there are none. |
| `next` | array of strings | `arnx accept` alone when every issue comes marked real and no issue waits on a question; else `arnx triage`, `arnx accept` when there are findings or questions (the user's); else empty. |

| `result` | Exit | When |
|---|---|---|
| `findings` | 1 | At least one confirmed finding. |
| `incomplete` | 2 | No confirmed finding, and the review did not finish (`problems` says why). |
| `clean` | 0 | No confirmed finding, and the review finished. |

`not-ready` (doctor's checks failed) and `error` (no consent, no approved environment, …) are as above.

### triage

With `--json` there is no terminal: nothing is drawn and no mark changes. The object is the review's marks and
answers as `review.md` holds them now (latest review, or the id given).

| Field | Type | Meaning |
|---|---|---|
| `review_id` | string | The review. |
| `review_md` | string | Its `review.md`, relative to the repository. |
| `findings` | array | Every finding: `{ id, status, mark, severity, rewrite, project, test_id, title }`. `status` as in review.json; `mark`: `real`, `intended`, `noise`, `rewrite` (the bug is real, its test is wrong) or null (unmarked; a confirmed finding comes marked `real`); `severity`: `high`, `medium`, `low` or null; `rewrite`: with the `rewrite` mark, the owner's reason (the `Rewrite:` line after the Mark line in review.md), else null. |
| `questions` | array | `{ id, question, answer }`; `answer` is null while unanswered. |

| `result` | Exit | When |
|---|---|---|
| `ok` | 0 | The marks were read. A `review.md` with two boxes ticked for one finding is an `error`. |

### allow-secret

| Field | Type | Meaning |
|---|---|---|
| `files` | array | One per file allowed: `{ path, matches, labels }`. `matches`: how many key-like strings it holds; `labels`: each one's kind and line, `{ label, line }` (`AKIA…`, `a private key`). Never the strings themselves. |
| `review_yaml` | string | `.arnx/review.yaml`, where they are pinned. |
| `next` | array of strings | `arnx setup` before setup, else `arnx approve` (the change needs approving again). |

| `result` | Exit | When |
|---|---|---|
| `ok` | 0 | Every file named was allowed. A file that is missing, outside the repository, named like a secret file or holding nothing key-like is an `error`, and nothing is written. |

### env prune

| Field | Type | Meaning |
|---|---|---|
| `dry_run` | boolean | `--dry-run`: nothing was removed; `removed` is what would be. |
| `keep_days` | number | Images younger than this were kept (`--keep-days`, default 7). |
| `removed` | array | `{ tag, project, age_days, size }` per image removed (or, with `dry_run`, to remove). `size` as Docker shows it (`1.2GB`). |
| `failed` | array | The same, plus `error`, per image Docker would not remove (in use, …). |
| `unlabelled` | number | `arnx-env` images without arnx's labels, always left alone. |

| `result` | Exit | When |
|---|---|---|
| `ok` | 0 | Every image to remove was removed (or none was to be). |
| `fail` | 2 | Some could not be removed (`failed`). |

### remove

| Field | Type | Meaning |
|---|---|---|
| `state` | string | `listed` (without `--yes`: nothing deleted), `removed` (`--yes`), or `nothing` (arnx left nothing here). |
| `dry_run` | boolean | No `--yes`: `deleted`, `images` and `pins` are what would be deleted. |
| `deleted` | array of strings | Files git does not track under `.arnx/`, `.arnxignore`, the skill folders and (with `--tests`) the accepted tests, repository-relative. |
| `tracked` | array of strings | Files there that git tracks: never deleted by arnx. |
| `git_rm` | string or null | The command that removes the tracked ones in a commit (`null`: none). |
| `images` | array | `{ tag, size }` per environment image of this repository. |
| `docker_checked` | boolean | `false`: Docker is not installed, so no image was looked for. |
| `pins` | string or null | The pin file arnx keeps for this clone outside it. |
| `kept_tests` | array of strings | Accepted test files left in place (without `--tests`). |
| `failed` | array | `{ path, error }` per file or image that could not be deleted. |
| `next` | array of strings | `arnx remove --yes` after a list. |

| `result` | Exit | When |
|---|---|---|
| `ok` | 0 | Listed, removed, or nothing to remove. |
| `fail` | 2 | Something could not be deleted (`failed`). |

### skill install

| Field | Type | Meaning |
|---|---|---|
| `state` | string | `written` (it was not there), `replaced` (`--force` over another version or an edited copy) or `unchanged` (already this arnx's skill; nothing written). |
| `dirs` | array of strings | The folders, relative to the repository, or under `~/` with `--user`. |
| `user` | boolean | `--user`: installed under the home directory. |

| `result` | Exit | When |
|---|---|---|
| `ok` | 0 | Installed, or already there. A folder holding another skill without `--force` is an `error`. |

### accept

`arnx accept [id] --json` (no id: the latest review). Nothing is asked: answers that need the consent to send code
stop it with an `error` object (`arnx consent` first, or `--no-answers`).

| Field | Type | Meaning |
|---|---|---|
| `review_id` | string | The review accepted. |
| `kept` | array of strings | The test files copied into the repository (support files such as `conftest.py` left out, as the text does). Empty when nothing was kept. |
| `dest` | string or null | The folder they went to (the deepest one they share; `.` for the repository root). null when nothing was kept. |
| `issues` | number | The issues the findings marked real make up (as `arnx review` counts them). |
| `marks` | object | The findings' marks, as numbers: `real`, `intended`, `noise`, `rewrite`, `unmarked`, and `left_as_prefilled` (marks review.md came with that nobody changed; also counted in the first four). |
| `answers` | array | One entry per answered question, then one per rewrite: see below. Empty with `--no-answers`. |
| `check` | object or null | The accepted tests run on the code as it is now: `failing`, each `{ project, test_id, message }` (the runner's failure message), and `passing`, a number. null with `--no-check`. |
| `fix_prompt` | string | The fix prompt for the coding agent (`.arnx/reviews/<id>/fix-prompt.md`); `arnx prompt --json` gives its text. |
| `next` | array of strings | The next steps, as the text says them: `give the fix prompt to your coding agent`, then `arnx check`, while accepted tests fail (or were not run); else `commit the fix and the accepted tests together` (or `commit the accepted tests`); empty when nothing was kept. |

Each answer:

| Field | Type | Meaning |
|---|---|---|
| `question` | string | The question's id (`Q1`), as in review.md; for a rewrite, its round's id (`R1`, `R2`, …, in the order review.md shows the issues). |
| `result` | string | `disagree`, `locked` or `no-test` (see below). |
| `tests` | array of strings | Test names: the failing ones (`disagree`) or the kept ones (`locked`); empty for `no-test`. |
| `cost_usd` | number | What writing the tests cost (0 when an earlier accept's tests for the same answer were reused). |
| `rewrite_of` | array of strings or null | For a rewrite: the findings marked `rewrite` in its issue, whose own tests were set aside. null for a question. |

A rewrite (an issue marked `rewrite` with a `Rewrite:` reason) runs the same round as an answer: the question is the
issue's title and expected behaviour, the answer "The test arnx wrote for this was wrong. " followed by the reason. Its
tests are kept beside the answers' and, when they fail, are accepted tests the fix must make pass. A finding marked
real that assumed an answer to a question (`depends_on`) has its own test set aside, skipped in the kept file, when
the owner answered that question and the answer's round kept a test.

| Answer `result` | When |
|---|---|
| `disagree` | Tests for the answer fail on the code: it does not do what was answered. They are kept, failing, like a finding marked real. |
| `locked` | The code already does what was answered; the tests are kept to lock it. |
| `no-test` | No test came of it (the answer does not settle it). |

| `result` | When |
|---|---|
| `ok` | Exit 0: the marks were recorded and the tests kept (also when nothing was marked real). Accepted tests that fail do not change it: they fail until the fix. |
| `error` | Exit 2 or 3: no review, a review already accepted (without `--again`), answers without the consent to send code, … |

`arnx accept --keep-edits --json`:

| Field | Type | Meaning |
|---|---|---|
| `changed` | array | The accepted test files recorded as they are now, each `{ path, change }`; `change` is `modified`, `deleted`, `repinned` or `unpinned`, as in [check-json.md](check-json.md). Empty when nothing changed. |
| `restored_tests` | array of strings | The files whose accepted-test list (`tests` in `.arnx/accepted-tests.json`) was edited: an edit there is not kept (it could relabel a failing accepted test as another one), so the list arnx wrote (HEAD's, else this machine's) is recorded again. The files themselves are recorded as they are now. Usually empty. |
| `recorded` | string | The record, `.arnx/accepted-tests.json` (unchanged when `changed` is empty): commit it with the tests. |

| `result` | When |
|---|---|
| `ok` | Exit 0, whether or not anything changed. |
| `error` | Exit 2: a review id or `--again` was given with `--keep-edits`. |

### prompt

`arnx prompt [id] --json` (no id: the review accepted last). The prompt's text also goes to stderr.

| Field | Type | Meaning |
|---|---|---|
| `review_id` | string | The review whose fix prompt it is. |
| `path` | string | The file: `.arnx/reviews/<id>/fix-prompt.md`. |
| `text` | string | The fix prompt: the file's whole markdown. |

| `result` | When |
|---|---|
| `ok` | Exit 0: the prompt is there. |
| `error` | Exit 2: no accepted review yet, no such review, or the review has no fix prompt yet (not accepted). |

### check

See [check-json.md](check-json.md).
