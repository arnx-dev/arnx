# arnx

Your coding agent says the change is done. arnx checks whether it works: it reads the change, writes tests for what
looks broken, runs them in Docker, and tells you what failed and what it cannot decide without you.

A finding is a test you can run, not a comment. arnx runs each one 3 times, runs it again on the code before the
change, has a second model challenge it, and lets you keep the useful ones as regression tests.

Status: early release (0.1). Python (pytest), JavaScript/TypeScript (vitest, jest, node:test, bun) and Rust
(cargo-nextest, [early](#rust-is-early)) repositories: a single package, a workspace, or many services. Open source
(Apache 2.0) with your own model keys, or with models run by [arnx cloud](docs/CLOUD.md).

## What a finding looks like

arnx reviewing its own `arnx remove` command (review `20261022-227eb7`, before 0.1). The change added a command that
deletes the files arnx put in a repository. arnx suspected it trusted the paths recorded in
`.arnx/accepted-tests.json` and wrote this test:

```ts
test("S2 accepted-test paths escaping the repository are never deleted", async () => {
  const { base, repo, env } = setup();
  const victim = join(base, "victim.txt");
  put(victim, "keep me");
  put(join(repo, ".arnx", "accepted-tests.json"), record({ "../victim.txt": {} }));
  const cli = new Cli({ cwd: repo, env });
  await withDocker("/nonexistent/docker", () => cli.run("remove", "--yes", "--tests"));
  expect(existsSync(victim)).toBe(true);
});
```

From the review's report:

```
### Issue 1 · remove --yes can delete files outside the repository
- Actual: In S2, `../victim.txt` outside the repository was deleted. …
- Failing tests: F2, F4

### F2 · regression · confirmed by the second opinion
- Failure: `expect(received).toBe(expected)`
- Before the change (regression): passes on the code before the change (3 runs): the change broke it
- Second opinion: planRemove takes accepted-tests.json keys verbatim and applyRemove rmSync's join(repo, p), …
```

The test failed in all 3 runs, passed on the code before the change, and the second model agreed with the
explanation. We marked it real, `arnx accept` kept it, a coding agent fixed `remove` from arnx's fix prompt, and
`arnx check` showed it passing. It still guards that behaviour, in
[tests/remove-safety.test.ts](tests/remove-safety.test.ts). Not every finding is like this one: in our own reviews,
some confirmed issues tested behaviour we intended. Deciding is your part.

## Install

You need **Docker** running (every test runs in it; arnx does not install it) and macOS or Linux (on Windows, WSL 2 with
Docker Desktop's WSL integration). With npm (Node 20 or later):

    npm install -g @arnx-dev/arnx

Or a standalone binary, no Node needed (`darwin-arm64`, `darwin-x64`, `linux-x64` or `linux-arm64`):

    curl -fLO https://github.com/arnx-dev/arnx/releases/latest/download/arnx-linux-x64
    chmod +x arnx-linux-x64 && mv arnx-linux-x64 /usr/local/bin/arnx

Each release lists the binaries' sha256 in `SHA256SUMS`. The macOS binaries are not signed yet: one downloaded in a
browser is quarantined, and `xattr -d com.apple.quarantine /usr/local/bin/arnx` releases it. `arnx --version` names
the build; `arnx doctor` checks Docker, keys and configuration.

## Quickstart

Pick where the models run. Either way the tests run in your Docker.

**With your own keys.** `export ANTHROPIC_API_KEY=...` is enough: every job runs on Claude, and you pay Anthropic
directly. Other providers and models: [docs/MODELS.md](docs/MODELS.md).

    arnx init                           # writes .arnx/config.toml and .arnxignore

**With arnx cloud.** No model keys; new accounts start with $5 of credit.

    arnx init --cloud                   # writes the config for arnx cloud
    arnx login                          # a device login: open the link it shows, enter the code

Then, in both cases:

    arnx setup                          # asks before sending code, finds how your tests run, proves it by running
                                        # your suite in Docker, then lists what is worth a look
    # ... let your agent change something ...
    arnx review                         # writes tests for the change and runs them: 2 issues confirmed (4 findings)
    arnx triage                         # mark real / intended / noise / rewrite, answer questions
    arnx accept                         # tests of real issues are kept in .arnx/tests/ (never in your own suite)
    arnx prompt                         # the fix prompt for your coding agent
    arnx check                          # runs the accepted tests; green means they pass now

Commit `.arnx/config.toml` and `.arnx/review.yaml`: teammates, other branches and CI reuse the proven environment.
Lost? `arnx next` says where you are in this flow and the command to run now; `arnx doctor` says what is missing.

`arnx review` looks at what a pull request would show: on a branch, every commit since it left the default branch
plus uncommitted work in tracked files; `--range A..B` picks any span. A review costs from a few cents to a few
dollars (our own reviews: $0.17 to $3.19) and stops writing tests at your cap, `review_usd` (default $3.00).

## What the evidence means

- **Reproduced failure:** a test arnx wrote failed in every run (3 by default). That shows an assertion fails, not
  that the code is wrong: the test can encode a wrong expectation.
- **Regression evidence:** the same test passes on the code before the change. Other outcomes are reported as they
  are: already failing before (not caused by the change), new code (nothing to compare), changed, or not checked.
- **Second opinion:** another model reads the test, the failure and the diff, and confirms or disputes it. That is a
  model's judgement. A finding it could not judge (budget, API error) counts as confirmed for the exit code, so a
  review never passes because the check did not run.
- **Your decision:** you mark each issue real, intended, noise, or rewrite (the bug is real, the test is wrong).
  Issues backed by a confirmed test come pre-marked real; change what you disagree with.
- **`arnx check`:** the tests you accepted pass on your working tree, in the sandbox. It shows the behaviour those
  tests check, nothing more. A review lists changed code no test touched as not covered, never as fine.

More in [docs/WORKFLOW.md](docs/WORKFLOW.md).

## The workflow

1. **setup** reads the repository, proposes one project per unit whose tests run on their own, and checks each by
   running its suite in Docker (no tests yet? arnx's own one-line test checks it instead). Nothing to approve: it
   ends with what is worth a look (test files set aside, what is not tested, allowed secret-looking files, downloads
   from outside the package registries). A changed `.arnx/review.yaml` is proven again before the next review.
2. **review** writes tests for the change, runs them 3 times, runs the failures on the code before the change, asks
   a second model, and writes `.arnx/reviews/<id>/review.md` with what was tested and what was not.
3. **triage** (or edit review.md) marks each issue and answers arnx's questions; answers become tests too.
4. **accept** keeps tests of real issues in `.arnx/tests/`, where your own test run never collects them, and pins
   each file's sha256 in `.arnx/accepted-tests.json`. Tests of other issues are left out.
5. **prompt** gives the fix prompt; **check** puts the accepted tests in place in a throwaway copy and runs them: a
   bug's test fails until the fix. A pinned test that was edited makes `check` refuse (exit 4): a test changed until
   it passes shows nothing. arnx never edits your code or your tests.

Details, exit codes, `--json` and the before/after check: [docs/WORKFLOW.md](docs/WORKFLOW.md).

## Coding agents

The arnx skill lets Claude Code (and other agents that read Agent Skills) close the loop: after a change it runs
`arnx review` once, after saying what it may cost, and hands the findings to you. Once you have triaged and accepted,
it fixes the code from `arnx prompt` until `arnx check` passes, runs each touched project's full suite, and reports.
Setup, marking findings, answering questions, `arnx accept`, `arnx init`, logins and commits stay yours: the
skill tells the agent never to run them or edit accepted tests (`arnx check` would refuse those anyway).

    arnx skill install                  # writes .agents/skills/arnx/ and .claude/skills/arnx/: commit them
    arnx skill install --user           # or under ~/, for every repository on this machine

In Claude Code it also installs as a plugin: `/plugin marketplace add arnx-dev/arnx`, then `/plugin install arnx@arnx`.
More: [docs/WORKFLOW.md](docs/WORKFLOW.md#coding-agents).

## Your keys or arnx cloud

| | Your own keys | arnx cloud |
|---|---|---|
| Models | the harness arnx is measured with, or any mix you configure | chosen and run by arnx cloud, effort low / medium / high |
| Pays | you, to each provider | prepaid credit; each review shows what it was billed |
| Prompts | in the open source, yours to change | arnx cloud's |
| Tests | your Docker | your Docker |
| Sent | the diff, files the agent reads, its tests and their output, to your providers | the same, to arnx cloud, which passes them to its model providers |

Secret files, files with key-shaped text and paths in `.arnxignore` are never sent; untracked files only with
`--untracked`. Sending code needs your consent, once per repository and destination. Switch with `arnx cloud on` /
`off`. Details: [docs/MODELS.md](docs/MODELS.md), [docs/CLOUD.md](docs/CLOUD.md), [docs/SAFETY.md](docs/SAFETY.md).

## Safety and data

- Tests run only in Docker, on a throwaway copy of the repository, with no network (only services in `.arnx/review.yaml`), no
  host environment and resource limits. Docker shares the host kernel: it is not a perfect boundary for hostile
  code, and image builds have network access to install dependencies.
- Your model keys stay in the arnx process, never in a container. The secrets filter is a heuristic: extend
  `.arnxignore` for anything else private.
- Accepted tests are code a model wrote: read them before you commit them. Only `arnx check` runs them.
- Telemetry is off unless you set `telemetry = true` in `.arnx/config.toml` (anonymous counts, never code or file
  names). `arnx remove` lists and deletes everything arnx added.

Full boundaries, what is sent and telemetry: [docs/SAFETY.md](docs/SAFETY.md). Security reports:
[SECURITY.md](SECURITY.md).

## Rust is early

Rust works, but it is the least tried of arnx's languages. A first setup is slow (the image compiles your dependencies
and every test target, and can take several GB); our own runs are small crates, not large workspaces; generated tests
are integration tests that see your crate's public API only. Just before launch we found that `arnx check` skipped the
Rust tests you had accepted (fixed in 0.1): expect a few more bugs like it. Point arnx at your crate and tell us what
broke and how long setup took.

## Known limits

- Changes up to 200 KB per review; review a long branch in parts with `--range A..B`.
- Python, JavaScript/TypeScript and Rust only (`arnx init` and `arnx doctor` say so for a repository in another
  language, before anything is sent). No Windows build: use WSL 2.
- Setup marks test files it cannot run as `known_failing`, with a reason that is a model's judgement: setup lists
  them under "Worth a look"; read those entries in `.arnx/review.yaml`.
- Model replies vary: two reviews of the same change can report different findings.

## Try it, and tell us

Point arnx at a real repository, swap the models, edit the prompts (`arnx prompts copy KEY`), and
[open an issue](https://github.com/arnx-dev/arnx/issues) with what happened: a bug it caught, a finding that was
wrong, a setup that failed, a layout it does not understand, a model mix that did better. `.arnx/precision.jsonl`
holds your marks with no code in it. See [CONTRIBUTING.md](CONTRIBUTING.md); how arnx works inside:
[DEVELOPING.md](DEVELOPING.md).

## Licence

Apache License 2.0: see [LICENSE](LICENSE) and [NOTICE](NOTICE).
