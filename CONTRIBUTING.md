# Contributing to arnx

arnx is open so you can poke at it. Swap the models, rewrite the prompts, point it at a language we barely tried,
and tell us what happened. Issues and pull requests on GitHub are the place for all of it.

## Ways to help, no internals needed

- **A finding was wrong.** The most useful report we get. Open a [wrong
  finding](https://github.com/arnx-dev/arnx/issues/new?template=wrong-finding.yml) issue: what the test expected, what
  the code is meant to do, and how you marked it (intended, noise or rewrite).
- **Setup failed, or arnx misread your layout.** Workspaces with many packages, unusual runners, services, Rust crates:
  tell us where setup stopped and what your test command is. A [bug
  report](https://github.com/arnx-dev/arnx/issues/new?template=bug.yml) with the setup output (private names taken out)
  is enough.
- **Other models.** Any model for any job (`[models]` in `.arnx/config.toml`, generic tables for any endpoint that
  copies the Anthropic or OpenAI API; [docs/MODELS.md](docs/MODELS.md)). DeepSeek, Kimi and OpenRouter are written
  commented out because we have not run them ourselves yet: you may be first.
- **Other prompts.** They all live in `src/prompts.ts`. Build your own arnx with them (`bun install && bun run smoke`
  gives `dist/arnx`) and run it on your code.
- **Rust.** It works but is the least tested language: a setup that fails on a real workspace is as useful to us as a
  found bug.
- **Language adapters.** Everything language-specific is in `src/adapters/` (Python, TypeScript, Rust): the test
  runner's command and report, how tests are skipped and where kept tests go. A new runner or language starts with an
  issue; [DEVELOPING.md](DEVELOPING.md#language-adapters) explains the pieces.

For a model or prompt experiment, open an
[experiment](https://github.com/arnx-dev/arnx/issues/new?template=experiment.yml) issue with the numbers from the
review: what it found, what you marked real, intended, noise or rewrite, and its cost line. `.arnx/precision.jsonl`
holds your marks with no code in it. We will try the combinations that catch more in our own measurements.

## Reporting a bug

Open an issue at https://github.com/arnx-dev/arnx/issues with:

- `arnx --version` (it names the exact build), your OS, Docker version, language and test runner;
- the command, what you expected and what happened, and whether it happens again on a second run;
- a small reproduction you are allowed to share, or the output with private names taken out.

Do not attach a whole `.arnx/` folder: `transcript.jsonl` and the generated tests can quote your code, and review.md
quotes it too. `.arnx/precision.jsonl` and `.arnx/reviews/<id>/docker.jsonl` (step timings) hold no code. Security
issues go by email, not in an issue: see [SECURITY.md](SECURITY.md).

## Pull requests

1. For anything larger than a small fix, open an issue first, so we agree on the behaviour before you write it.
2. Read [DEVELOPING.md](DEVELOPING.md): how a review flows, the modules, and the rules that must stay true (untrusted
   code only in Docker, keys never leave the process, arnx never edits the user's code).
3. Before you push:

       bun install
       bun test
       bunx tsc --noEmit
       bun run smoke

   Tests never call a model or need keys; `ARNX_DOCKER_TESTS=1 bun test` also runs real containers.
4. Keep the change focused, add a test that fails without it, and keep CLI messages short.

A pull request that changes `src/prompts.ts` changes `PROMPT_VERSION` and the reviews we measure, so tell us what it
catches that the current prompts miss, with reviews to show it. A prompt you only want for yourself does not need to
come back here: keep your build.

## Licence

arnx is under the [Apache License 2.0](LICENSE). By opening a pull request you agree that your contribution is
licensed under it too (section 5 of the licence); there is no separate agreement to sign.
