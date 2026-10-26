# Safety and data

What runs where, what leaves your machine, and what arnx keeps. Security reports: [SECURITY.md](../SECURITY.md).

## What runs where

- Tests run only in Docker: no network (only the services in `.arnx/review.yaml`), no environment variables except
  the ones in it, CPU, memory and process limits, on a throwaway copy of your repository.
- Each test environment is a Docker image (`arnx-env:<hash>`), built again when the install steps or the dependency
  files change; Rust images can take several GB. With `context = "precise"` (`.arnx/config.toml`), each one also
  gets a code indexer layer (`arnx-env:<hash>-scip1`, about 0.7 GB for Python and TypeScript; the indexer runs with
  no network). When the install copies your code into the image (`cp -r . /opt/app`), arnx builds one more image per
  version of the code it tests (`arnx-env:<hash>-src-<hash>`), reused for that code. `arnx env prune` removes this
  repository's images that no proven project uses now and are a week old (`--keep-days N`, `--dry-run` to list them
  first, `--all-repos` for other repositories' old images too), and with each image made from your code the build
  cache records its build left, each by its id; the rest of Docker's build cache is not touched.
- `arnx remove` lists everything arnx put in the repository (`.arnx/`, `.arnxignore`, the skill folders), this
  repository's test images and the pins arnx keeps for it outside the repository; `arnx remove --yes` deletes them.
  Files you committed are left for the `git rm` it prints, so the removal shows in a commit. Accepted tests are your
  tests by then: kept unless `--tests`. Your arnx cloud login and the arnx program itself are not touched.
- Your model keys stay in the arnx process. Files that usually hold secrets, and text that looks like a key, are
  never sent to a model. A file left out this way is named at setup and in each review. When its key-shaped text
  is test fixtures (a secret detector's own tests), `arnx allow-secret PATH` pins each such string in
  `.arnx/review.yaml`, which is then proven again before the next review; a new key-shaped string in that file
  withholds it again. Setup lists allowed files under "Worth a look".
  When a setup run fails on a file left out this way (or by `.arnxignore`), setup stops and names it: only you can
  let it in.
- arnx never edits your code or your tests. `accept` writes only into `.arnx/` (accepted tests in `.arnx/tests/`,
  where your own test run never collects them).
- Accepted tests are code a model wrote. They run only through `arnx check`, in the proven sandbox. Read them
  before you commit them.
- Setup asks nothing about the environment it writes: it proves it by running your suites. Its install steps, written
  by the setup agent, run with network access when the image builds; setup lists under "Worth a look" any install
  line that downloads with `curl`, `wget` or `git clone` from outside the package registries.
- Data files (CSV and other exports, dumps, databases, images) are kept out by `.arnxignore`, which `arnx init`
  writes: patterns for them, the test fixture folders (`tests/`, `fixtures/`, `testdata/`, …) kept with `!` lines,
  and any other data-like file the repository has, by name. An existing `.arnxignore` is left as it is. A `!` line
  keeps what it matches again; the last line that matches a path decides.

## What a review sends

What a review sends to the model providers: the diff, the files the reviewer reads and the output of the tests it runs.
Uncommitted work means tracked files only: staged and unstaged changes, and new files once you `git add` them. Untracked
files are in neither the diff, the copy the reviewer reads nor the sandbox, and the review says how many it left out.
`--untracked` sends them too and names each one (`untracked = true` under `[review]` in `.arnx/config.toml` does it
always; `--no-untracked` overrides that); `arnx setup` reads the same way. With no commits yet every file is sent, and
the review says so first. Paths in `.arnxignore`, secret files and files with key-shaped text are never sent (see [What
runs where](#what-runs-where)). review.json records `untracked_included` or `untracked_left_out`.

With arnx cloud, the same content goes to arnx cloud instead of your providers, and arnx cloud passes it to its model
providers ([CLOUD.md](CLOUD.md)).

## Telemetry

Off unless you turn it on: anonymous usage counts, never code or file names. `arnx init` writes `telemetry = false` at
the top of `.arnx/config.toml`; set it to `true` to send them from that repository. `ARNX_TELEMETRY=0` or
`DO_NOT_TRACK=1` keeps it off everywhere. `arnx doctor` shows the state in one line.

When it is on, `setup`, `review`, `accept` and `check` each end by sending one line to
`https://api.arnx.dev/v1/telemetry`: a random install id for this machine (kept in
`$XDG_CONFIG_HOME/arnx/telemetry.json`, else `~/.config/arnx/telemetry.json`), the arnx version, OS and CPU type, the
command, and counts for it: projects and their languages, files changed and the diff's size, effort, the model providers
(not the models), findings, verdicts and before/after results, tests written, passed, flaky or erroring, your marks as
counts (real, rewrite counted as real, intended, noise, unmarked; chosen or left as they came), questions answered,
cost, duration and exit code.

Never sent: code, diffs, file names or paths, test names or content, messages, the questions or your answers,
repository names or remotes, user names, environment variables, keys.

Sending never slows a command by more than 2 seconds and never changes what it does or its exit code: one try,
errors ignored, nothing queued.

## Sharing a run with us

Open an issue at https://github.com/arnx-dev/arnx/issues, with the output of `arnx --version` (it names the exact
build). The most useful thing to share is `.arnx/precision.jsonl`: your marks (real, intended, noise, rewrite) per
finding, with review ids and no code. For a slow or failed run, `.arnx/reviews/<id>/docker.jsonl` (step timings only)
helps; `transcript.jsonl` can quote your code, so share it only if your code allows.
