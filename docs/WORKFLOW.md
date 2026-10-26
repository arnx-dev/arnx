# The arnx workflow

The flow, what each step writes, and what its results mean. Start with the [README](../README.md); models are in
[MODELS.md](MODELS.md), arnx cloud in [CLOUD.md](CLOUD.md), boundaries and data in [SAFETY.md](SAFETY.md).

    arnx init → arnx setup → arnx review → arnx triage → arnx accept → arnx prompt → arnx check

Commit `.arnx/config.toml` and `.arnx/review.yaml`: the next branch, a teammate's clone and CI reuse the proven
environment without running setup again.

Lost? `arnx next` says where the repository is in this flow and the command to run now. `arnx doctor` says what is
missing (keys, Docker, configuration); setup and review run the same checks first.

## Projects and setup

`arnx setup` reads your repository and proposes one project per unit whose tests run on their own (a package, a
service, a crate), each with its own environment, and checks each by running its existing suite. It shows a coverage
map: what each project owns, what it only uses (such as a shared library), and what no project tests, with the
reason. A review tests every project the change touches and lists what it could not test. `arnx setup --add` covers
more later: it tries every uncovered entry again, so fix what its reason names first; `arnx setup --project NAME` redoes one project. Projects that install the same way (a Cargo workspace,
one lockfile at the root) share one environment image when they have the same `image`, `install` and
`install_root` (the directory the install runs in); otherwise each project builds its own.

A project with no tests of its own (common in apps a coding agent built) is fine: setup checks its environment with
arnx's own one-line test instead of a suite, and says so in the table (`no tests of its own; arnx's one-line test
runs`). Reviews then run only the tests arnx writes. A `test_command` that deletes or writes files (`rm`, `mv`, `cp`,
`sed -i`, `tee`, `> file`) is refused: every run must see the repository as it is.

Before it starts, setup says what it will do and gives a rough time and cost estimate. While it runs, it shows on
stderr each model reply, each file it reads and each suite it runs (`--quiet` turns this off). It then shows one
line per project, runs every suite once more and stamps `.arnx/review.yaml` with a hash (the proof); nothing is asked.
It ends with what is worth a look, only what applies: test files set aside as known failing, tests skipped for want
of a service or variable, commands that ignore their own errors (`|| true`), install lines that download from outside
the package registries (`curl`, `wget`, `git clone`), files allowed although they look like secrets, and what no
project tests. The same list, with who ran the proof (the git user), is in `.arnx/setup/approval.md`. Open
`.arnx/review.yaml` in an editor for the full file.

A `.arnx/review.yaml` changed since its proof (edited by hand, in a pull request, or by `arnx allow-secret`) is
noticed and proven again before the next `review`, `check` or `accept` uses it. First it says what changed since the
last proof, per project: `test_command` (old → new), `install`, files added to or removed from `known_failing`, `env`,
`services`, `owns`, `uses`, any other key by name, and projects added or removed. It compares with the copy the last
proof kept in `.arnx/setup/proven-review.yaml` (a local file; without it, as after a proof by an older arnx or in a
fresh clone, it says there is no copy to compare), stamp or not; a file whose stamp holds but whose content is not
that copy's (a stamp recomputed by hand) counts as changed too. With `--json`, the command's object says so in
`reproved`. Then the suites run and the file is stamped again, followed by what
is worth a look; the changes go into `.arnx/setup/approval.md` too. When a suite fails there, the command stops and
names the failing tests (exit 3). `arnx approve` runs the same proof on its own, saying the same.

### Rust crates

Rust works, but it is the least tried of arnx's languages, so here is where it stands:

- **Setup is slow.** The environment image compiles your dependencies and every test target, so a first setup takes
  minutes on a small crate and much longer on a big workspace, and the image can take several GB. Later reviews reuse
  it until `Cargo.toml`, `Cargo.lock` or the toolchain changes.
- **Little tested.** Our own runs are small crates and our test fixtures, not large real-world workspaces. We found a
  bug: `arnx check` skipped the Rust tests you had accepted (fixed in 0.1); expect a few more.
- **Generated tests are integration tests** (`tests/arnx_*.rs`): they see your crate's public API only, since arnx
  never edits `src/`. A bug behind a private function is reached through the public one, or not at all.

That makes it a good place to play. Point arnx at your crate, swap the models (see
[MODELS.md](MODELS.md#make-it-yours)), and tell us in an issue what broke, how long setup took and what it caught. A
failing setup on a real workspace is just as useful to us as a found bug.

## What a review looks at

What `arnx review` looks at: on a branch, every commit since it left `main` (or `master`, or the remote's default
branch) plus any uncommitted work, as a pull request would show it; on the default branch, uncommitted work, else
the last commit. `arnx review --range A..B` picks any other span. In a repository with no commits yet, the change is
every file git does not ignore (less what `.arnxignore` and the secrets filter leave out), so there is no code before
it for the before/after check; over the size limit, commit part of the files first and review the rest.

The hunter also reads where the project uses each function the change touches, two levels out, found by name. With
`context = "precise"` under `[review]` in `.arnx/config.toml`, arnx first indexes each project's code in its test
image (scip-python, scip-typescript or rust-analyzer; no network) and follows the function itself, so another
module's function or constant with the same name stays out. Indexing adds about 10 to 50 seconds per project to a
review and builds one extra layer per test image; when the index cannot be built, the review goes on by name. Setup
then also checks the map once: a `uses` entry the project's code never refers to, or code it refers to outside its
`owns` and `uses`, goes back to the setup agent as a hint. Without an index, setup still checks the map's paths
once: a `uses` entry with no leading `/` that matches in several places (`api/` also matching `packages/api/`), or
one that takes in two or more other projects whole (a catch-all `services/`), would have those changes reviewed
twice, so it goes back to the setup agent as a hint too.

What a review sends, and what it leaves out (untracked files, `.arnxignore`, secrets):
[SAFETY.md](SAFETY.md#what-a-review-sends).

## Exit codes and JSON

Exit codes: 0 no confirmed findings, 1 confirmed findings, 2 incomplete, 3 setup needed. `arnx check`: 0 all accepted
tests pass, 1 some fail, 2 some did not report, 3 nothing accepted yet, 4 an accepted test changed since accept.
Every command takes `--json`: one JSON object on stdout, the text on stderr, nothing asked (fields in
[skills/arnx/references/json.md](../skills/arnx/references/json.md)).

## The report

review.md opens with a status: what was tested, and what was not and why. Changed source files that no arnx test refers
to are listed by name, and the review then says "partly covered" instead of "complete": finding nothing in a file no
test touched says nothing about it. Findings that share one cause are grouped into an issue and explained as input,
actual, expected and why it matters (written by the second model after the verdicts), with a severity estimate that puts
the most severe issues first and minor ones (leftover debug output, logging, test helpers) last. Each issue has one mark
for all its tests: an issue backed by a confirmed test comes pre-marked real, so `arnx accept` can follow straight away
unless you disagree. A pre-mark is arnx's default, not a verdict: review.md itself says "a confirmed test proves",
meaning the test failed in every run and the second opinion agreed; whether that behaviour is a bug is yours to say. A
question no issue waits on is optional. A finding the second model could not judge (review budget reached, or an API
error) counts as confirmed for the exit code, so a review never passes silently because the check did not run.

## Before and after the change

Each test that failed in every run then runs again, as many times, on the code before the change (its base; HEAD
for uncommitted work), in the same sandbox image, with no model call. A finding is marked a regression when it passes
there; one that fails the same way there is listed under "Already failing before this change": it was not caused by
the change, is not sent to the second opinion and does not set the exit code (mark it real to keep it as a test
anyway). Tests that passed in every run also run there (up to 20 per project): one that fails there in every run
shows the change fixes what it checks, and review.md says so under "The change fixes". `before_check = false` under
`[review]` in `.arnx/config.toml` turns both off; `fix_proof_max = 0` turns off only the second.

What each outcome means: **regression** (passes before, fails after: the change broke what the test checks, if the
test is right); **pre-existing** (fails the same way before: not caused by the change); **new-code** (what it tests
does not exist before, so there is nothing to compare); **changed** (fails before too, differently: kept as a
finding); **unknown** (not checked, or nothing settled: flaky, an error, no base, or the change altered the image's
dependencies so a same failure would prove nothing). Only regression is evidence about the change itself. A test
that reads one of the project's source files as text and matches it is never a regression or a fix: it shows the
text changed, not the behaviour, so its outcome there is unknown and review.md says why.

## Type check

A TypeScript project can name its own type check in `.arnx/review.yaml` (`typecheck: npx tsc --noEmit -p
tsconfig.json` beside `test_command`; setup proposes it when the project has a tsconfig.json and typescript). A review
runs it once on the change, without arnx's generated tests, and when it reports errors once on the code before the
change, so review.md says which type errors are new with the change and which were already there. It is reported on
its own, under "Type check": it never fails a test, turns a run into no report, or sets the exit code.

## After a review

1. Mark the review: `arnx triage` steps through the issues in the terminal (arrow keys move, space selects, enter goes
   on) and lets you type answers; or edit `.arnx/reviews/<id>/review.md` by hand. Issues backed by a confirmed test come
   pre-marked real: change only what you disagree with. An issue left unmarked is not accepted. A test that checks the
   code's text, or only that something exists, is noted as such: a change can pass it without fixing the behaviour.
   `.arnx/precision.jsonl` (on your machine, not committed) keeps every mark, and whether you chose it (changed it, or
   picked it in `arnx triage`) or left it as it came.
2. `arnx accept <id>` (without an id: the review started last). Tests behind findings marked real are copied into
   `.arnx/tests/`, at the path each runs from: `.arnx/tests/<project root>/tests/arnx/r<id>/` (`accepted_tests_dir`
   in `.arnx/config.toml`; at that default a TypeScript project uses `__tests__/arnx/r<id>/`, and a Rust crate
   `tests/arnx_<id>_<name>.rs`). Your own test run never collects them there, so they cannot change it; only
   `arnx check` puts them in place, in a throwaway copy. Each file is named after the problem it
   protects (`test_deep_json_recursion.py`); answered questions become tests of the behaviour you described (one model
   round each, run in parallel; `answer_model` in `.arnx/config.toml` can pick a cheaper model; `--no-answers` skips
   them). Only the tests you keep go in: those of findings marked intended or noise, flaky ones and those set aside
   are cut out of the copied files (they stay in `.arnx/reviews/<id>/`). A real bug whose test is wrong is marked
   rewrite, with a `Rewrite:` line saying why: its test is left out and the reason becomes a new test, like an answer.
   A test that assumed an answer you gave differently is left out too when your answer got a test of its own. The test
   of a bug not fixed yet is kept as it is: it fails in `arnx check` until the fix. Accept then runs the accepted tests
   and lists the ones that fail now (`--no-check` skips the run). Your code is not changed and nothing is committed.
   `arnx setup` proves the place: its run of your suite carries a one-line test in `.arnx/tests/`, and setup stops
   if your runner collects it (a pytest `norecursedirs`, say, that drops the default hidden-folder rule).
3. Fix the code, or hand `arnx prompt` (also in `.arnx/reviews/<id>/fix-prompt.md`; `accept --copy` puts it on the
   clipboard) to your coding agent: the failing tests, what each bug is, your answers, and the rules (yours with
   `arnx prompts copy fix.rules`). `arnx check` runs the accepted tests in the proven sandbox, services included,
   on your working tree, and lists what still fails.
4. When `arnx check` passes, commit the fixes together with `.arnx/tests/`, `.arnx/accepted-tests.json` and
   `.arnx/answer-watch.json` (when there is one): they now guard against the bugs coming back, each time `arnx check`
   runs. Read them first: they are code a model wrote.

Accepted tests are pinned. `accept` records the sha256 of each file it writes in `.arnx/accepted-tests.json`, with
the file's accepted tests (so `arnx check` tells them from the other tests the review wrote into it), and
`arnx check` refuses to run (exit 4) when one was edited or deleted since: a test changed until it passes shows
nothing, and a coding agent told to make `arnx check` pass cannot do it that way. Editing the record along with the
test does not help either: a sha256 there counts only when it is the committed one or one `arnx accept` wrote on this
machine (it keeps a copy in `~/.config/arnx/pins/`, outside the repository); a changed or removed entry exits 4 too.
A fresh clone or CI has no such copy and trusts the committed record, so a commit that edits both shows only in its
diff: `arnx review` of that change names the accepted tests and pins it edits or removes.
Changed by mistake: `arnx accept --again <id>` copies the review's tests back (your edits are lost); `arnx check`
also names `git checkout -- <file>` when the committed copy is the accepted one. Changed on purpose:
`arnx accept --keep-edits` records the accepted tests as they are now. An answer's test can ask for the opposite of an
accepted test: `accept` records, for each answer test that fails, the accepted tests that pass beside it
(`.arnx/answer-watch.json`, committed with the tests), and when a later `arnx check` finds the answer's test passing
and one of those failing it says `Q1's test now passes and F3's fails: they may contradict` (the exit code is
unchanged); decide which one holds. `arnx check --json` prints the result as JSON
(each project's passed and failed tests, the overall result, the changed files) for programs and coding agents.

Tests an older arnx kept inside your projects (`tests/arnx/`, with expected-fail markers) are in your own test run:
`arnx check` runs nothing until `arnx accept --move` moves them to `.arnx/tests/`, removes their markers and pins
them there. Commit the move.

Accept before fixing: a test you saw fail before the fix and pass after it is good evidence that the fix changed the
behaviour it checks, provided the test checks the right thing (that is what your mark says).

Or fix first: `arnx check --review [id]` (no id: the latest review) runs that review's confirmed tests, from
`.arnx/reviews/<id>/`, on the working tree in the proven sandbox and says per finding fixed, still failing or no
report (exit 0, 1, 2; 3 when there is no such review). The review already saw them fail 3 times on the bug; a fix
counts when its test passes in every run (`runs`, 3 by default), and one failing run is enough to say it still fails.
Nothing is accepted, copied or recorded, and no model is called. `--json` for programs and coding agents.

What `arnx check` establishes: the accepted tests, unedited (their pins match), pass on your working tree in the
proven sandbox. It says nothing about behaviour no accepted test checks, and an accepted test that encodes a wrong
expectation passes or fails for the wrong reason: mark it rewrite in its review and accept again (`arnx check` points
there when one fails).

## Coding agents

The arnx skill lets a coding agent (Claude Code, and others that read Agent Skills) close the loop itself: when it has
finished a change it runs `arnx review` once, after saying what it may cost, and hands you the findings, questions and
cost, changing no code. Once you have run `arnx triage` and `arnx accept`, it runs `arnx check`, fixes the code from
`arnx prompt` until `arnx check` passes, then runs each touched project's full suite with the accepted tests in it (a
passing `arnx check` covers only the accepted tests), and reports. Setup, marking findings, answering
questions, `arnx accept`, `arnx init`, any login and commits stay yours: the skill tells the agent never to run them,
and never to edit accepted tests (`arnx check` would refuse them anyway). Without arnx installed, the
agent shows you the install line and runs it only when you say yes. Code no project covers is reported as "Not reviewed
by arnx", never as checked; the agent asks whether to add unit tests for it (self-contained, saved fixtures, no
network), and after your yes writes them so `arnx setup --add`, which you run, can cover that code.

    arnx skill install                  # writes .agents/skills/arnx/ and .claude/skills/arnx/: commit them
    arnx skill install --user           # or the same under ~/, for every repository on this machine

`arnx init` names the command (an `Optional:` line) until the repository has the skill. An existing different copy (an
older version, or edited) is replaced only with `--force`. In Claude Code the skill also installs as a plugin:
`/plugin marketplace add arnx-dev/arnx`, then `/plugin install arnx@arnx`. The skill is in
[skills/arnx/](../skills/arnx/), with the JSON it reads documented in its `references/`.
