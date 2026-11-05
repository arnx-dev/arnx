# Safety and data

What runs where, what leaves your machine, and what arnx keeps. Security reports: [SECURITY.md](../SECURITY.md).

## What runs where

- Tests run only in Docker: no network (only the services in `.arnx/review.yaml`), no environment variables except
  the ones in it, CPU, memory and process limits, on a throwaway copy of your repository. A network for services has no
  way out and no address on this machine, on Docker 28 or later. On an older Docker a test with services declared can reach
  what listens on this machine, a database too; arnx says so when it happens.
- Each test environment is a Docker image (`arnx-env:<hash>`), built again when the install steps or the dependency
  files change; Rust images can take several GB. With `context = "precise"` (`.arnx/config.toml`), each one also
  gets a code indexer layer (`arnx-env:<hash>-scip1`, about 0.7 GB for Python and TypeScript; the indexer runs with
  no network). When the install copies your code into the image (`cp -r . /opt/app`, or `pip install .` when your
  tests import the installed package rather than the code in /src), arnx builds one more image per
  version of the code it tests (`arnx-env:<hash>-src-<hash>`), reused for that code. `arnx env prune` removes this
  repository's images that no proven project uses now and are a week old (`--keep-days N`, `--dry-run` to list them
  first, `--all-repos` for other repositories' old images too), and with each image made from your code the build
  cache records its build left, each by its id; the rest of Docker's build cache is not touched. Such images built
  by arnx before 0.1.3 do not say which records are theirs: prune removes the image, leaves the cache, and says so
  (`docker builder prune` removes all of Docker's unused build cache, if you want that).
- `arnx remove` lists everything arnx put in the repository (`.arnx/`, `.arnxignore`, the skill folders), this
  repository's test images and the pins arnx keeps for it outside the repository; `arnx remove --yes` deletes them,
  with the build cache of the images made from your code (as `arnx env prune` removes it).
  Files you committed are left for the `git rm` it prints, so the removal shows in a commit. Accepted tests are your
  tests by then: kept unless `--tests`. Your arnx cloud login and the arnx program itself are not touched.
- Your model keys stay in the arnx process. Files named like secrets are not sent to a model. A file left out for what it
  holds is named at setup and in each review. When every key-shaped string in a JavaScript, TypeScript, Python or Rust file,
  a private key aside, is inside a comment that has its lines to itself (a doc example), the file is sent with those comment
  lines blanked instead, and setup names the file and its lines. Everything else that may be a secret reaches a model as a
  stand-in, a fake of the same shape (its prefix such as `sk-`, `whsec_` or `AKIA` kept, then the same length and kinds
  of characters, hex staying hex), in every request, whatever it holds: a file read, a search, a test's output. The same
  goes for its JSON and URL forms, its upper and lower case, its hex (a dump's hex column too) and its base64, also inside
  the base64 of a longer text (`Basic base64(user:value)`), and for what arnx writes or prints for you and your coding agent:
  `review.md`, `review.json`, `round.json`, `fix-prompt.md`, and the output of `arnx prompt`, `arnx check` and
  `arnx check --review`. These say so, and name the test's file and line, which hold the real code.
  **No filter is complete.** arnx hides a value and its common encodings; a test or a command that prints a cut or
  transformed form can get past it, and tests run on the real guesses (below). A cut goes only where it keeps the value's start
  or end up to a word's edge, from 12 characters: `cut -c3-30`, a start cut running into a letter and `fold -w16` show the rest
  raw. A lower-case hex dump (`xxd`, `od -tx1`) leaves a run of at most 4 bytes of a 16-byte value, and up to 20 of 32 on a longer
  one, as its middle lines show. `hexdump -C`'s gap leaves more: 8 to 11 of 16 bytes unless the value starts at offset 0 or 8,
  up to 28 of 32 on a longer one. A dump's text column shows pieces. Nothing recognises a value reversed (`rev`), in rot13,
  base32, wrapped base64 (`base64 -w8`), a dump of swapped words (plain `hexdump`, `od -x`), an upper-case dump (`xxd -u`),
  `xxd -i`, `od -c`, `%XX` of every byte, `list()`, compressed or hashed, nor one written with escapes in the source
  (`"ab\x55c"`).
  Local files arnx writes for itself keep what they saw: `change.diff` (minus the files left out and a pinned file's key) and image build logs,
  neither of which `arnx init`'s `.arnx/.gitignore` lets git take. What a commit of `.arnx/` takes (`review.yaml`, `baseline.json`, accepted tests) holds
  stand-ins, apart from a value you wrote into `review.yaml` yourself.
  What the tests run depends on how sure arnx is. Key-shaped text and a password in an address get the stand-in in the
  snapshot too, wherever they appear, so no file keeps them and every file gets the same fake; the tests run with the
  fake, and one that checks a signature made with the real value (a signed license key) fails. A guess stays as it is
  in the snapshot, since a wrong guess must not change code that runs, and those runs have no network beyond the services
  you declared (see the Docker version above). A guess is a literal given to a secret-looking name (token, secret, password, credential, private,
  authorization, API key; also key, auth, salt or cookie when the value looks random; the word must be what the name is,
  its last one: `AUTH_TOKEN`, `secret_key`, not `TOKEN_PROGRAM` or `account_key`) in code, JSON, YAML, TOML, INI or env
  files, as an assignment, a keyword argument or a `("NAME", "value")` pair; on a command line or in a build file
  (`export NAME=value`, `docker run -e`, `ENV`, a Makefile's `:=`, `Authorization: Bearer value`); or in a URL's query
  (`?api_key=value`). Words or a name (`password123`, `PublicKey`), a placeholder, a URL or a path don't count, nor does a
  value the name says is a hash, signature, public, id or label. A value in a `.env*` file at the top of the repository
  counts wherever it appears: those files are read for this and copied nowhere. A random-looking string (hex or base64)
  is a guess only where such a name marks it: unnamed, it is a hash, a commit id, an address or a signature that tests
  compare.
  Building an image has network, so it gets a second copy of the snapshot in which each guess is a stand-in too. The
  project's own manifests (the files that key its image, by its adapter and folder) and lockfiles are the exception: they
  keep their own values in both copies, as a stand-in there can break an install, so an install step can read those. No other
  file keeps them. An install that copies the project elsewhere (`cp -a . /opt/app`, `pip install .`) copies that second copy, so tests
  that run there see stand-ins for guesses. Binary files are left alone. The real values never leave your machine,
  beyond what a manifest or a lockfile holds and what the limits above let through. Setup names the files whose snapshot has stand-ins once.
  A model works among stand-ins, so what it writes holds them. When its text meets real files, arnx swaps each guess's
  stand-in back, in memory and at the last moment: a test as it goes into the throwaway copy, an accepted test too (the file
  under `.arnx/` keeps the stand-in); a search pattern and a path; a command of setup's `exec`; and the env and commands of
  `review.yaml` when they run, inside the run's network. `review.yaml` itself keeps the stand-in, and `install` is never
  swapped, since a build has network. Whatever a run prints then goes out through the filter again. A key-shaped value's
  stand-in stays, as it is what the code holds. A project whose tests run on an install's copy stays among stand-ins, as that
  copy does: nothing is swapped for its runs, so a test there that reads a project file by any path, `/src` or relative, and
  compares with a stand-in fails.
  Only a plain stand-in comes back. One a model encoded, re-cased or cut itself stays as written, and a test holding it fails
  on the real value; a test that encodes a plain stand-in when it runs is fine. A stand-in a real file holds, by chance or
  because a coding agent copied it into tracked code, stays as written everywhere, since there it means itself.
  While a run lasts, a test holding a real guess sits on disk in the temporary snapshot, and real values appear in
  `docker run -e` and `sh -c` arguments, which `ps` on this machine shows.
  `[review] stand_ins = false` in `.arnx/config.toml` turns stand-ins off in both copies: files with key-shaped text in code
  are left out, and requests still hold stand-ins for the other values.
  A review's diff blanks comment lines the same way and names them.
  **Private keys.** A key with an intact header (PEM, PGP's block, SSH2's four dashes, any label), or a run of 64 or more
  base64 characters in either alphabet that starts as a key's encoding (a whole PEM in base64, an OpenSSH body, private DER),
  does not reach a model, within the limits below. The file holding one, on either side of a change, is left out of the diff
  and the snapshot: the review names it with a label and a line, and the rest is reviewed. A file whose key is only on its
  removed side keeps its clean copy in the snapshot. arnx does not read what is under a header, so a placeholder (`...` in a
  doc or a form, a bare header in a comment) leaves its file out until you allow it.
  The filter replaces the same text with `[private key]` in what leaves arnx, test and `exec` output too, before arnx cuts it:
  from a header to its END line, or with no END for 16 KB; and from the start of a text to an END with no header before it,
  which covers a page or a cut that starts inside a key. A model's own test keeps what it wrote where it is saved to run, so
  an accepted test stays whole; a model reads it masked. A model told to write `[private key]` is refused, and so is a
  `review.yaml` holding it: a test that needs a key reads the file at run time.
  A test that needs a file left out could not run, and reads so: it is no finding. A file over 1 MB that is binary, or over
  32 MB, is searched a piece at a time and left out on a hit, whatever a pin says. A path that cannot be read counts as a hit.
  A change of only such files stops, naming what can free it: `arnx allow-secret`, `--range`, or that a range cannot be allowed.
  **These get past it:** JWK; hex; PKCS12 and PBES1 encrypted keys; lower-case or altered armour; a header broken up in the
  source (`"...PRIV" + "ATE KEY"`) over a body with another start; with no header, a body with another start, one with spaces
  or other marks inside its lines, one wrapped too short to hold the start, or one glued to a word before it (`rsaMII...`); a
  key in a file name; a key longer than the 16 KB limit with no END; in text arnx did not cut, what follows a stray END inside
  a body; a line a tool cuts at 200 columns, which can leave under 64 characters of a no-header run. Other text that may be a
  secret goes through the filter below, and a value it does not recognise goes out.
  **Allowing a file.** When a file's key-shaped text is test fixtures (a secret detector's own tests), `arnx allow-secret PATH`
  pins it in `.arnx/review.yaml`, which is then proven again before the next review. Other key-shaped strings are pinned one by
  one, and a new one withholds the file again. A file holding a private key is pinned by the hash of its whole text: as it
  stands, as committed, before the last commit and where its branch left, beside those pinned before. It stays in the diff and the sandbox, so its
  tests run, and a model sees `[private key]` on each of its lines in a diff, a read or a search; test output that prints it is masked as above. A header with no END covers its own line and the all-base64 lines right after it, so the rest of the file reads as it is. Each piece of 8 characters or more in both cases also gets a stand-in; a key wrapped shorter, or a piece in one case, does not. A pin sends no key:
  any edit withholds the file until you allow it again, and a string pin from before this rule holds no private key. `arnx allow-secret`
  takes only the working tree's file: one deleted cannot be allowed. `arnx allow-secret --remove PATH` takes a file off the list (proven again too). Setup lists
  allowed files under "Worth a look".
  When a setup run fails on a file left out this way, setup stops and names it: only you can let it in. When it
  fails on a file `.arnxignore` leaves out, setup copies that file into the sandbox (scrubbed the same way, never sent
  to a model; it is in the snapshot only while a test runs), says so in one line, runs the project again, and lists
  the file under `sandbox_only` in `.arnx/review.yaml` and under "Worth a look". This holds for every line of
  `.arnxignore`, arnx's defaults and yours alike: `init` writes data files it finds there by name, so the file does
  not tell them apart. A test's output still goes to the model, and may quote such a file.
- A variable whose name looks like a secret (KEY, TOKEN, SECRET, PASSWORD, CREDENTIAL, …) is refused in
  `.arnx/review.yaml` unless listed under `allow_env_names` or set to `arnx:generated` (64 hex digits arnx makes) or
  `arnx:generated:base64` (32 bytes, URL-safe base64): throwaway values, the same in every run.
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
the review says so first. Paths in `.arnxignore`, secret files (`.pem`, `.key`, `.ppk` and the like) and files holding a private key (see the limits there) are not sent, and other
key-shaped text goes as a stand-in (see [What runs where](#what-runs-where)). review.json records `untracked_included` or
`untracked_left_out`, and `not_sent` the files left out.

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
